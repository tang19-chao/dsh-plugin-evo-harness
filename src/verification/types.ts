/**
 * C2a (ADR 0003 §4): the host-owned trusted-verification contract.
 *
 * "Trusted" is NOT "the verifierId string is in an allowlist". It is: a receipt
 * produced by the host's OWN runner instance, registered inside that instance's
 * per-run registry under `(runId, trajectoryId, role)`, and bound to an artifact
 * digest the HOST recomputed from the artifact bytes. A payload that merely
 * claims a verifier identity - including one a branch/executor attached to its
 * own result - never becomes trusted (ADR 0003 T1/T2).
 *
 * The receipt is written as a structural SUPERSET of the existing
 * `TrustedVerification` shape (step-evaluator.ts:556-564) into the open
 * `trajectory.metadata` bag, because that interface lives in a file this task
 * must not edit (ADR 0003 §4.2 "超集随附"). `isTrustedVerification` validates
 * field-by-field and does not reject extra keys, so a superset object still
 * enters the scorer; the extra keys (`verificationId`/`binding`/`kind`) are the
 * HOST's own bookkeeping and are validated by the attach side, not the scorer
 * (ADR 0003 §4.2 约束 3 / C2a-O2).
 */
import type { TrajectoryRole, TrajectoryStatus } from '../types/contracts';

/** Marker distinguishing a host runner receipt from a self-declared payload. */
export const HOST_VERIFICATION_KIND = 'host-runner' as const;

/** Artifact digest algorithm tag; the digest is `sha256:<64 hex chars>`. */
export const ARTIFACT_DIGEST_PREFIX = 'sha256:' as const;

/**
 * The artifact bytes the host verified. `producedFiles` is kept as a sorted
 * copy so the digest is order-insensitive (the host reads a file SET).
 */
export interface HostArtifact {
  readonly content: string;
  readonly producedFiles: readonly string[];
}

/**
 * The four-part binding (ADR 0003 T4): `taskId` + `testSetId` + `envId` +
 * `runId`, plus the trajectory identity. Any missing or mismatching member is a
 * rejection, never a "best-effort" attach.
 */
export interface VerificationBinding {
  readonly runId: string;
  readonly sessionId: string;
  readonly trajectoryId: string;
  readonly role: TrajectoryRole;
  readonly taskId: string;
  readonly testSetId: string;
  readonly envId: string;
  readonly artifactDigest: string;
}

/**
 * The host receipt. A structural superset of `TrustedVerification`:
 * `status`/`verifierId`/`verifierVersion`/`evidenceHash`/`checks` are the fields
 * the scorer reads; `verificationId`/`binding`/`kind` are the host-side
 * authentication bookkeeping.
 */
export interface HostVerificationReceipt {
  readonly status: 'passed' | 'failed';
  readonly verifierId: string;
  readonly verifierVersion: string;
  /** Always the host-recomputed artifact digest (ADR 0003 T3). */
  readonly evidenceHash: string;
  readonly checks: readonly { readonly id: string; readonly passed: boolean }[];
  /** Stable id: `<verifierId>@<verifierVersion>#<runId>#<trajectoryId>`. */
  readonly verificationId: string;
  readonly binding: VerificationBinding;
  readonly kind: typeof HOST_VERIFICATION_KIND;
}

/**
 * The bounded rejection/audit reason vocabulary (ADR 0003 §4.6, including the
 * R-a addition `artifact-missing`). Codes are only attached to a disposition
 * when something was REJECTED or audited; a clean trusted attachment carries no
 * code (there is deliberately no `attached` member - the enum is a rejection
 * vocabulary, and the trusted fact is `authenticated === true`).
 */
export const VERIFICATION_REASON_CODES = [
  'no-runner',
  'artifact-missing',
  'malformed-receipt',
  'implicit-payload',
  'unregistered-receipt',
  'digest-mismatch',
  'binding-mismatch',
  'test-set-mismatch',
  'env-mismatch',
  'run-mismatch',
  'stale-artifact',
  'execution-not-completed',
  'falsified-success-claim',
  'contradictory-verdict',
  'reference-receipt-missing',
  'duplicate-receipt',
  'runner-error',
  'runner-timeout'
] as const;
export type VerificationReasonCode = (typeof VERIFICATION_REASON_CODES)[number];

/**
 * What the host decided for ONE trajectory. This is the "host-authenticated
 * trajectory view": the recorder consumes `auditOnly`, and diagnostics/reports
 * read the reason.
 *
 * `authenticated` is the HOST's verdict (registry + binding + digest all
 * matched). It is deliberately NOT named `trusted`: the consumer-side
 * `trustedSource` flag is a separate fact (the scorer additionally requires the
 * injected producer set to contain the verifierId), and the two must stay
 * distinguishable in reports (ADR 0003 §4.5.3: a runner with an empty producer
 * set is authenticated but conservative-degraded).
 */
export interface VerificationDisposition {
  /** True when the receipt was written into `metadata.verification`. */
  readonly attached: boolean;
  /** Host-side authentication result (registry identity + binding + digest). */
  readonly authenticated: boolean;
  /** True when the recorder must write the audit-only encoding (ADR 0003 §5.2). */
  readonly auditOnly: boolean;
  /**
   * ADR 0003 §4.3 truth-table rows that are audit-only REGARDLESS of the
   * process gate: an abnormal execution (`timeout`/`aborted`/`cancelled`/
   * `infrastructure_error`), a contradictory verdict, a falsified success claim,
   * or a run whose reference receipt is missing. The recorder ANDs this into the
   * consumption gate, so such a record can never be consumed even though the
   * (withheld) verdict would have left it process-eligible.
   */
  readonly forceAuditOnly?: boolean;
  /** Present iff a receipt existed (rejected, audited or attached). */
  readonly verdict?: 'passed' | 'failed';
  readonly reasonCode?: VerificationReasonCode;
  readonly reason?: string;
  readonly artifactDigest?: string;
  readonly verifierId?: string;
  readonly verifierVersion?: string;
  readonly verificationId?: string;
  readonly testSetId?: string;
  readonly envId?: string;
  /** True when the runner returned the receipt already registered for this run. */
  readonly duplicate?: boolean;
}

/** The read-only view `readVerificationView` projects out of a trajectory. */
export interface VerificationView {
  readonly disposition: VerificationDisposition;
  readonly receipt?: HostVerificationReceipt;
}

/** Per-request input to the host runner. */
export interface HostVerificationRequest {
  readonly runId: string;
  readonly sessionId: string;
  readonly trajectoryId: string;
  readonly role: TrajectoryRole;
  readonly taskId: string;
  /** Execution status as recorded by the collector (never rewritten here). */
  readonly executionStatus: TrajectoryStatus;
  readonly artifact: HostArtifact | undefined;
}

/** The runner's answer: either a receipt, or a bounded refusal reason. */
export interface HostVerificationRunnerOutcome {
  readonly receipt?: HostVerificationReceipt;
  readonly reasonCode?: VerificationReasonCode;
  readonly reason?: string;
  /** The registry already held this receipt (idempotent re-verification). */
  readonly duplicate?: boolean;
}

/**
 * The host-owned runner. `trustedProducers` is the caller-owned set the scorer
 * consumes as its SECOND necessary condition; it is NOT the source
 * authentication (that is the registry identity check).
 */
export interface HostVerificationRunner {
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly testSetId: string;
  readonly envId: string;
  readonly trustedProducers: ReadonlySet<string>;
  verify(request: HostVerificationRequest): Promise<HostVerificationRunnerOutcome>;
  /** Registry read: the receipt registered for this run/role, if any. */
  receiptFor(
    runId: string,
    trajectoryId: string,
    role: TrajectoryRole
  ): HostVerificationReceipt | undefined;
  /** Registry size, for diagnostics/tests. */
  readonly size: number;
}

/**
 * The orchestrator seam. Absent (or `enabled: false`) means "no host runner":
 * no attachment, no receipt, no marks - byte-identical to the pre-C2a
 * lifecycle (ADR 0003 §4.5.1). There is deliberately NO config field that
 * produces this seam (§4.5.2).
 */
export interface HostVerificationSeam {
  readonly runner: HostVerificationRunner;
  /** Defaults to enabled; `false` behaves exactly like an absent seam. */
  readonly enabled?: boolean;
  /** Optional hard budget; exceeding it yields `runner-timeout`. */
  readonly timeoutMs?: number;
}
