/**
 * C2a (ADR 0003 §4.2/§4.3): the attach side - the ONE place that decides
 * whether a host receipt may reach the scorer, and which audit-only encoding a
 * rejected/abnormal trajectory gets.
 *
 * Why here and not in the scorer (ADR 0003 §4.2 约束 3 / C2a-O2): the scorer
 * (`src/jitrl/step-evaluator.ts`) is out of scope AND does not know the
 * superset fields. Two of the frozen truth-table rows are literally
 * unreachable from the scorer side:
 *   - `failed` execution + trusted `passed` is DOWNGRADED to `unknown` by
 *     `verificationFromTrajectory` BEFORE scoring, so the contradiction must be
 *     caught here (`contradictory-verdict`);
 *   - `timeout` + trusted `failed` is process-eligible in the scorer (the
 *     `isLearningOutcome` predicate is frozen and must not be changed), so the
 *     abnormal-execution gate must be applied here.
 *
 * Structural guarantees:
 *   - with a seam configured, the returned trajectory's `metadata.verification`
 *     is either the registry-authenticated receipt or ABSENT - any inherited
 *     (branch/executor self-declared) payload is stripped, so a self-declared
 *     verdict can never reach the scorer on the host path;
 *   - the digest written into `deliverable.contentHash` is the host-recomputed
 *     one, which is what makes the scorer's existing `expectedEvidenceHash`
 *     comparison branch actually run in production (T3);
 *   - a trusted attach never happens for an abnormal execution, a contradictory
 *     verdict, an unauthenticated receipt, or a run whose reference receipt is
 *     missing (ADR §4.3/§4.4 fail-closed).
 */
import { classifyTrajectoryOutcome } from '../jitrl/step-evaluator';
import type { ExperienceOutcome, ProbeTrajectory } from '../types/contracts';
import { artifactDigestOf, artifactOf } from './artifact-digest';
import {
  HOST_VERIFICATION_KIND,
  type HostVerificationReceipt,
  type HostVerificationSeam,
  type VerificationBinding,
  type VerificationDisposition,
  type VerificationReasonCode,
  type VerificationView
} from './types';

/** Metadata key the scorer reads (`readTrustedVerification`). */
export const VERIFICATION_METADATA_KEY = 'verification' as const;
/** Metadata key the host reads back (never consumed by the scorer). */
export const VERIFICATION_AUDIT_KEY = 'verificationAudit' as const;

/** Outcomes that must never carry task-quality evidence (ADR §4.3 row 5). */
const ABNORMAL_OUTCOMES: readonly ExperienceOutcome[] = [
  'timeout',
  'aborted',
  'cancelled',
  'infrastructure_error'
];

export function isAbnormalExecutionOutcome(outcome: ExperienceOutcome): boolean {
  return ABNORMAL_OUTCOMES.includes(outcome);
}

const TIMEOUT_SENTINEL: unique symbol = Symbol('host-verification-timeout');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Host-side shape validation of a receipt (superset-aware; scorer shares none of this). */
export function isHostVerificationReceipt(value: unknown): value is HostVerificationReceipt {
  if (!isRecord(value)) {
    return false;
  }
  if (value['status'] !== 'passed' && value['status'] !== 'failed') {
    return false;
  }
  if (
    !nonEmptyString(value['verifierId']) ||
    !nonEmptyString(value['verifierVersion']) ||
    !nonEmptyString(value['evidenceHash']) ||
    !nonEmptyString(value['verificationId'])
  ) {
    return false;
  }
  if (value['kind'] !== HOST_VERIFICATION_KIND || value['implicit'] === true) {
    return false;
  }
  const checks = value['checks'];
  if (!Array.isArray(checks) || checks.length === 0) {
    return false;
  }
  for (const check of checks) {
    if (!isRecord(check) || !nonEmptyString(check['id']) || typeof check['passed'] !== 'boolean') {
      return false;
    }
  }
  const binding = value['binding'];
  if (!isRecord(binding)) {
    return false;
  }
  for (const field of [
    'runId',
    'sessionId',
    'trajectoryId',
    'role',
    'taskId',
    'testSetId',
    'envId',
    'artifactDigest'
  ] as const) {
    if (!nonEmptyString(binding[field])) {
      return false;
    }
  }
  return true;
}

/**
 * The host-authenticated trajectory view, read back from metadata.
 *
 * t18 / t11 F-3 hardening: a `metadata.verificationAudit` object is trusted ONLY
 * when this host module created it (registry identity) AND it still agrees with
 * the trajectory it was written for:
 *   1. the object is the exact instance registered for THIS trajectory id;
 *   2. an `authenticated` mark carries its complete host fields
 *      (`verifierId` + `verificationId` + `artifactDigest`) - completeness is a
 *      belt-and-braces gate, never the authentication itself;
 *   3. its `artifactDigest`, when present, equals the digest the host recomputes
 *      from the trajectory's CURRENT artifact;
 *   4. an `attached` mark still carries the receipt it was created with, bound
 *      to this trajectory and the same digest/verifier/verificationId.
 * Anything else is "unknown": no disposition, no marks, no eligibility change.
 * The default no-runner path never writes a mark at all, so this reader sees
 * nothing there either (ADR §4.5.1).
 */
export function readVerificationDisposition(
  trajectory: ProbeTrajectory
): VerificationDisposition | undefined {
  const metadata = trajectory.metadata;
  if (!isRecord(metadata)) {
    return undefined;
  }
  const candidate = metadata[VERIFICATION_AUDIT_KEY];
  if (!isRecord(candidate)) {
    return undefined;
  }
  // 1. host-registry identity + the trajectory the mark was written for.
  const registered = HOST_AUDIT_REGISTRY.get(candidate);
  if (registered === undefined) {
    return undefined;
  }
  if (registered.trajectoryId !== trajectory.id) {
    return undefined;
  }
  const disposition = registered.disposition;
  if (
    typeof disposition.attached !== 'boolean' ||
    typeof disposition.authenticated !== 'boolean' ||
    typeof disposition.auditOnly !== 'boolean'
  ) {
    return undefined;
  }
  // 2. an authenticated mark must carry the complete host identity.
  if (
    disposition.authenticated === true &&
    (disposition.verifierId === undefined ||
      disposition.verificationId === undefined ||
      disposition.artifactDigest === undefined)
  ) {
    return undefined;
  }
  // 3. the mark must still describe THIS artifact (host recomputation).
  if (disposition.artifactDigest !== undefined) {
    const artifact = artifactOf(trajectory);
    if (artifact === undefined || artifactDigestOf(artifact) !== disposition.artifactDigest) {
      return undefined;
    }
  }
  // 4. an attached mark must still carry the receipt it was created with.
  if (disposition.attached) {
    const receipt = metadata[VERIFICATION_METADATA_KEY];
    if (!isHostVerificationReceipt(receipt)) {
      return undefined;
    }
    if (
      receipt.verificationId !== disposition.verificationId ||
      receipt.verifierId !== disposition.verifierId ||
      receipt.binding.trajectoryId !== trajectory.id ||
      receipt.binding.artifactDigest !== disposition.artifactDigest ||
      receipt.evidenceHash !== disposition.artifactDigest
    ) {
      return undefined;
    }
  }
  return disposition;
}

export function readVerificationView(trajectory: ProbeTrajectory): VerificationView | undefined {
  const disposition = readVerificationDisposition(trajectory);
  if (disposition === undefined) {
    return undefined;
  }
  const metadata = trajectory.metadata;
  const candidate = isRecord(metadata) ? metadata[VERIFICATION_METADATA_KEY] : undefined;
  return {
    disposition,
    ...(isHostVerificationReceipt(candidate) ? { receipt: candidate } : {})
  };
}

function markOf(disposition: VerificationDisposition): Readonly<Record<string, unknown>> {
  return {
    kind: HOST_VERIFICATION_KIND,
    attached: disposition.attached,
    authenticated: disposition.authenticated,
    auditOnly: disposition.auditOnly,
    ...(disposition.forceAuditOnly === true ? { forceAuditOnly: true } : {}),
    ...(disposition.verdict === undefined ? {} : { verdict: disposition.verdict }),
    ...(disposition.reasonCode === undefined ? {} : { reasonCode: disposition.reasonCode }),
    ...(disposition.reason === undefined ? {} : { reason: disposition.reason }),
    ...(disposition.artifactDigest === undefined ? {} : { artifactDigest: disposition.artifactDigest }),
    ...(disposition.verifierId === undefined ? {} : { verifierId: disposition.verifierId }),
    ...(disposition.verifierVersion === undefined
      ? {}
      : { verifierVersion: disposition.verifierVersion }),
    ...(disposition.verificationId === undefined ? {} : { verificationId: disposition.verificationId }),
    ...(disposition.testSetId === undefined ? {} : { testSetId: disposition.testSetId }),
    ...(disposition.envId === undefined ? {} : { envId: disposition.envId }),
    ...(disposition.duplicate === true ? { duplicate: true } : {})
  };
}

/**
 * The host-side audit registry (t18 / t11 F-3): the ONLY proof that a
 * `metadata.verificationAudit` object was written by this host module.
 *
 * The mark is registered by OBJECT IDENTITY (a WeakMap key), so:
 *   - a branch/host-injected-seam payload can never be accepted merely because
 *     its fields look right (a three-boolean object, or a deep copy of a real
 *     mark, is a DIFFERENT object -> unknown);
 *   - the entry dies with the mark object, so a long-lived process does not
 *     accumulate state.
 * The registration also pins the trajectory it was written for, so a mark
 * cannot be moved onto another probe.
 */
interface HostAuditRegistration {
  readonly disposition: VerificationDisposition;
  readonly trajectoryId: string;
}

const HOST_AUDIT_REGISTRY = new WeakMap<object, HostAuditRegistration>();

/**
 * Apply a disposition to a trajectory WITHOUT mutating it. The returned object
 * is the one every downstream consumer must use (tree, composition, recorder),
 * so the digest/verdict pair stays consistent for the whole run.
 */
export function applyVerificationDisposition(
  trajectory: ProbeTrajectory,
  disposition: VerificationDisposition,
  receipt: HostVerificationReceipt | undefined
): ProbeTrajectory {
  const metadata: Record<string, unknown> = { ...(isRecord(trajectory.metadata) ? trajectory.metadata : {}) };
  if (disposition.attached && receipt !== undefined) {
    metadata[VERIFICATION_METADATA_KEY] = receipt;
  } else {
    // Strip any inherited payload: trust is only ever conferred by this host
    // path, never by data a branch attached to its own result (T2).
    delete metadata[VERIFICATION_METADATA_KEY];
  }
  const mark = markOf(disposition);
  // Register BEFORE publishing: the identity is the authenticity proof.
  HOST_AUDIT_REGISTRY.set(mark, { disposition, trajectoryId: trajectory.id });
  metadata[VERIFICATION_AUDIT_KEY] = mark;
  const deliverable =
    disposition.attached && disposition.artifactDigest !== undefined && trajectory.deliverable !== undefined
      ? { ...trajectory.deliverable, contentHash: disposition.artifactDigest }
      : trajectory.deliverable;
  return {
    ...trajectory,
    ...(deliverable === undefined ? {} : { deliverable }),
    metadata
  };
}

export interface VerifyAndAttachInput {
  readonly seam: HostVerificationSeam | undefined;
  readonly trajectory: ProbeTrajectory;
  readonly runId: string;
  readonly taskId: string;
  /**
   * ADR §4.4.2: when the REFERENCE probe produced no trusted receipt, every
   * candidate receipt of that run is audit-only (`reference-receipt-missing`),
   * so `learningTarget` is never computed from a one-sided comparison.
   */
  readonly referenceReceiptMissing?: boolean;
  readonly diagnostics?: string[];
}

export interface VerifyAndAttachResult {
  readonly trajectory: ProbeTrajectory;
  readonly disposition?: VerificationDisposition;
}

async function raceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined
): Promise<T | typeof TIMEOUT_SENTINEL> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Verify one trajectory and return the trajectory the run must continue with.
 *
 * With no seam (or `enabled: false`) the input trajectory is returned
 * unchanged and NO disposition is produced: the default assembly stays
 * byte-identical (ADR §4.5.1).
 */
export async function verifyAndAttach(input: VerifyAndAttachInput): Promise<VerifyAndAttachResult> {
  const seam = input.seam;
  if (seam === undefined || seam.enabled === false) {
    return { trajectory: input.trajectory };
  }
  const trajectory = input.trajectory;
  const role = trajectory.role;
  const diagnostics = input.diagnostics;
  // The outcome (and therefore the abnormal-execution row of the frozen truth
  // table) is known before any rejection, so every rejection can declare
  // whether the ADR requires the record to be audit-only regardless of the
  // process eligibility the scorer would compute.
  const outcomeKind = classifyTrajectoryOutcome(trajectory);
  const abnormalExecution = isAbnormalExecutionOutcome(outcomeKind);
  const reject = (
    reasonCode: VerificationReasonCode,
    reason: string,
    extra: Partial<VerificationDisposition> = {},
    opts: {
      readonly forceAuditOnly?: boolean;
      readonly receipt?: HostVerificationReceipt;
      /** True when the receipt passed registry+binding+digest authentication. */
      readonly authenticated?: boolean;
    } = {}
  ): VerifyAndAttachResult => {
    const disposition: VerificationDisposition = {
      attached: false,
      authenticated: opts.authenticated === true,
      auditOnly: true,
      // ADR 0003 §4.3 row 5: an abnormal execution is audit-only regardless of
      // what the (rejected) verdict said, so no timeout/cancel/infra record can
      // ever be consumed as reliable-failure evidence.
      ...(abnormalExecution || opts.forceAuditOnly === true ? { forceAuditOnly: true } : {}),
      reasonCode,
      reason,
      ...extra
    };
    diagnostics?.push('c2a: trajectory ' + trajectory.id + ' verification ' + reasonCode + ': ' + reason);
    return {
      trajectory: applyVerificationDisposition(trajectory, disposition, opts.receipt),
      disposition
    };
  };

  const artifact = artifactOf(trajectory);
  if (artifact === undefined) {
    return reject(
      'artifact-missing',
      'no artifact to verify (missing deliverable, or empty content with no produced files)'
    );
  }
  const digest = artifactDigestOf(artifact);

  let outcome: Awaited<ReturnType<HostVerificationSeam['runner']['verify']>> | typeof TIMEOUT_SENTINEL;
  try {
    outcome = await raceTimeout(
      seam.runner.verify({
        runId: input.runId,
        sessionId: trajectory.sessionId,
        trajectoryId: trajectory.id,
        role,
        taskId: input.taskId,
        executionStatus: trajectory.status,
        artifact
      }),
      seam.timeoutMs
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reject('runner-error', 'the host runner threw: ' + message);
  }
  if (outcome === TIMEOUT_SENTINEL) {
    return reject('runner-timeout', 'the host runner exceeded its ' + String(seam.timeoutMs) + 'ms budget');
  }

  const receipt = outcome.receipt;
  const verdictInfo = (value: HostVerificationReceipt): Partial<VerificationDisposition> => ({
    verdict: value.status,
    artifactDigest: digest,
    verifierId: value.verifierId,
    verifierVersion: value.verifierVersion,
    verificationId: value.verificationId,
    ...(isRecord(value.binding) && nonEmptyString(value.binding['testSetId'])
      ? { testSetId: value.binding['testSetId'] as string }
      : {}),
    ...(isRecord(value.binding) && nonEmptyString(value.binding['envId'])
      ? { envId: value.binding['envId'] as string }
      : {}),
    ...(outcome.duplicate === true ? { duplicate: true } : {})
  });

  if (receipt === undefined) {
    return reject(
      outcome.reasonCode ?? 'runner-error',
      outcome.reason ?? 'the host runner produced no receipt'
    );
  }
  if (outcome.reasonCode === 'stale-artifact') {
    // The receipt is real but belongs to an EARLIER artifact of this
    // trajectory: never attached to the artifact presented now (ADR §4.7.1).
    return reject(
      'stale-artifact',
      outcome.reason ?? 'the registered receipt was computed over an earlier artifact digest',
      verdictInfo(receipt),
      { receipt, authenticated: true }
    );
  }
  const registered = seam.runner.receiptFor(input.runId, trajectory.id, role);
  if (registered === undefined || registered !== receipt) {
    return reject(
      'unregistered-receipt',
      'the receipt is not the object registered by this host runner for this run/trajectory/role',
      verdictInfo(receipt)
    );
  }
  if ((receipt as unknown as Record<string, unknown>)['implicit'] === true) {
    return reject(
      'implicit-payload',
      'an implicit (structurally derived) payload is never trusted',
      verdictInfo(receipt)
    );
  }
  if (!isHostVerificationReceipt(receipt)) {
    return reject(
      'malformed-receipt',
      'the receipt is missing required host fields (status/identity/evidenceHash/checks/binding/kind)',
      verdictInfo(receipt)
    );
  }
  const binding: VerificationBinding = receipt.binding;
  if (
    binding.taskId !== input.taskId ||
    binding.trajectoryId !== trajectory.id ||
    binding.role !== role ||
    binding.sessionId !== trajectory.sessionId
  ) {
    return reject(
      'binding-mismatch',
      'the receipt binding does not match this task/trajectory/role/session',
      verdictInfo(receipt)
    );
  }
  if (binding.runId !== input.runId) {
    return reject('run-mismatch', 'the receipt was produced for a different run', verdictInfo(receipt));
  }
  if (binding.testSetId !== seam.runner.testSetId) {
    return reject(
      'test-set-mismatch',
      'the receipt was produced against a different test set (' + binding.testSetId + ')',
      verdictInfo(receipt)
    );
  }
  if (binding.envId !== seam.runner.envId) {
    return reject(
      'env-mismatch',
      'the receipt was produced in a different environment (' + binding.envId + ')',
      verdictInfo(receipt)
    );
  }
  if (binding.artifactDigest !== digest || receipt.evidenceHash !== digest) {
    return reject(
      'digest-mismatch',
      'the receipt evidence hash is not the digest the host recomputed from this artifact',
      verdictInfo(receipt)
    );
  }

  // ---- frozen truth table (ADR 0003 §4.3) --------------------------------
  if (abnormalExecution) {
    return reject(
      'execution-not-completed',
      'the execution ended as ' + outcomeKind + '; a verdict on it is audit-only, never a reliable task failure',
      verdictInfo(receipt),
      { forceAuditOnly: true, receipt, authenticated: true }
    );
  }
  if (trajectory.status !== 'succeeded' && receipt.status === 'passed') {
    return reject(
      'contradictory-verdict',
      'the execution did not succeed (' + trajectory.status + ') but the verdict claims passed',
      verdictInfo(receipt),
      { forceAuditOnly: true, receipt, authenticated: true }
    );
  }
  if (input.referenceReceiptMissing === true) {
    return reject(
      'reference-receipt-missing',
      'the reference probe of this run has no trusted receipt; the candidate verdict is audit-only',
      verdictInfo(receipt),
      { forceAuditOnly: true, receipt, authenticated: true }
    );
  }
  if (trajectory.status === 'succeeded' && receipt.status === 'failed') {
    // Falsified success claim: the scorer marks it ineligible; the recorder must
    // write the audit-only encoding and keep the verdict/reason (ADR §4.3 row 2).
    const disposition: VerificationDisposition = {
      attached: true,
      authenticated: true,
      auditOnly: true,
      forceAuditOnly: true,
      reasonCode: 'falsified-success-claim',
      reason: 'the run claimed success but the trusted verdict refuted the task result',
      ...verdictInfo(receipt)
    };
    diagnostics?.push(
      'c2a: trajectory ' + trajectory.id + ' verification falsified-success-claim (trusted failed verdict kept for audit)'
    );
    return {
      trajectory: applyVerificationDisposition(trajectory, disposition, receipt),
      disposition
    };
  }
  const disposition: VerificationDisposition = {
    attached: true,
    authenticated: true,
    auditOnly: false,
    ...(outcome.duplicate === true
      ? {
          reasonCode: 'duplicate-receipt' as VerificationReasonCode,
          reason: 'the receipt was already registered for this trajectory; first write wins'
        }
      : {}),
    ...verdictInfo(receipt)
  };
  diagnostics?.push(
    'c2a: trajectory ' +
      trajectory.id +
      ' verified by ' +
      receipt.verifierId +
      '@' +
      receipt.verifierVersion +
      ' (' +
      receipt.status +
      ', ' +
      digest.slice(0, 15) +
      '…)'
  );
  return {
    trajectory: applyVerificationDisposition(trajectory, disposition, receipt),
    disposition
  };
}

/**
 * The rewardSources numeric marks the recorder persists (ADR §4.2/§5.2). They
 * are the ONLY persisted representation of the verification outcome: the
 * record contract is frozen and must not grow a readable verification field
 * (C2a-O1).
 *
 * `outcomeEligible` is the OUTCOME-level fact (`isLearningOutcome`), so the
 * ADR's discriminator holds for every audit-only record: `outcomeEligible=1`
 * with a false record is the audit encoding (a verdict existed but was not
 * consumed), while `outcomeEligible=0` is an outcome veto (cancel/abort/infra)
 * or an abnormal execution.
 *
 * `undefined` means "no seam was configured for this run": the recorder then
 * writes no marks at all, keeping the default assembly byte-identical.
 */
export function verificationRewardMarks(input: {
  readonly disposition: VerificationDisposition | undefined;
  readonly verdict: 'passed' | 'failed' | 'unknown';
  readonly trustedSource: boolean;
  /** Outcome-level process eligibility (`isLearningOutcome`). */
  readonly outcomeEligible: boolean;
  /** True when the record went down the LEARNING branch. */
  readonly consumed: boolean;
}): Readonly<Record<string, number>> | undefined {
  const disposition = input.disposition;
  if (disposition === undefined) {
    return undefined;
  }
  // The reported verdict is the HOST fact only when the host authenticated it
  // (so an audit-only row keeps its real verdict/reason). For a REJECTED
  // receipt the host authenticated nothing, so the consumer-side verdict is
  // reported instead - a rejected "passed" claim must never appear as a verdict
  // on the record.
  const hostVerdict =
    disposition.authenticated === true && disposition.verdict !== undefined
      ? disposition.verdict
      : undefined;
  const verdict = hostVerdict ?? input.verdict;
  const verdictDerived = verdict === 'passed' || verdict === 'failed';
  return {
    outcomeEligible: input.outcomeEligible ? 1 : 0,
    verificationVerdict: verdict === 'passed' ? 1 : verdict === 'failed' ? 2 : 0,
    verificationTrusted: input.trustedSource ? 1 : 0,
    verificationAuditOnly: !input.consumed && (verdictDerived || disposition.auditOnly) ? 1 : 0
  };
}

/** Per-run summary used by the `record_experience` stage detail. */
export interface VerificationRunSummary {
  readonly trusted: number;
  readonly auditOnly: number;
  readonly reasonCodes: readonly VerificationReasonCode[];
}

/**
 * The factual `trustedVerificationSource` stage string. With no seam the exact
 * pre-C2a literal is kept (default-assembly equivalence); with a seam it states
 * what actually happened instead of a constant claim.
 */
export function verificationSourceDescription(
  seam: HostVerificationSeam | undefined,
  summary: VerificationRunSummary
): string {
  if (seam === undefined || seam.enabled === false) {
    return 'shape-only (C2-pre: no trusted producer registered)';
  }
  const base = 'host-runner:' + seam.runner.verifierId + '@' + seam.runner.verifierVersion;
  if (summary.trusted === 0 && summary.auditOnly === 0) {
    return base + ' (no receipt produced this run)';
  }
  const reasons =
    summary.reasonCodes.length === 0 ? '' : ', reasons=' + [...new Set(summary.reasonCodes)].sort().join('|');
  return base + ' (trusted=' + String(summary.trusted) + ', audit-only=' + String(summary.auditOnly) + reasons + ')';
}

/** Convenience for hosts/tests: fold a disposition into a run summary. */
export function accumulateVerificationSummary(
  summary: VerificationRunSummary,
  disposition: VerificationDisposition | undefined
): VerificationRunSummary {
  if (disposition === undefined) {
    return summary;
  }
  return {
    trusted: summary.trusted + (disposition.attached && !disposition.auditOnly ? 1 : 0),
    auditOnly: summary.auditOnly + (disposition.auditOnly ? 1 : 0),
    reasonCodes:
      disposition.reasonCode === undefined
        ? summary.reasonCodes
        : [...summary.reasonCodes, disposition.reasonCode]
  };
}
