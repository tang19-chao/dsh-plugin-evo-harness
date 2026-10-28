/**
 * C2a (ADR 0003 §4): host-owned trusted verification - public surface.
 *
 * Composition:
 *   createHostOwnedVerificationRunner  -> the host's own deterministic verifier
 *   verifyAndAttach                    -> registry/binding/digest authentication
 *                                         and the frozen eligibility truth table
 *   readVerificationView               -> the host-authenticated trajectory view
 *   verificationRewardMarks            -> the persisted audit marks
 */
export {
  ARTIFACT_DIGEST_PREFIX,
  HOST_VERIFICATION_KIND,
  VERIFICATION_REASON_CODES,
  type HostArtifact,
  type HostVerificationReceipt,
  type HostVerificationRequest,
  type HostVerificationRunner,
  type HostVerificationRunnerOutcome,
  type HostVerificationSeam,
  type VerificationBinding,
  type VerificationDisposition,
  type VerificationReasonCode,
  type VerificationView
} from './types';
export {
  ARTIFACT_FRAMING_VERSION,
  artifactBytes,
  artifactDigestOf,
  artifactOf
} from './artifact-digest';
export {
  createHostOwnedVerificationRunner,
  type HostOwnedVerificationRunnerOptions,
  type HostVerificationCase,
  type HostVerificationCheck
} from './host-runner';
export {
  VERIFICATION_AUDIT_KEY,
  VERIFICATION_METADATA_KEY,
  accumulateVerificationSummary,
  applyVerificationDisposition,
  isAbnormalExecutionOutcome,
  isHostVerificationReceipt,
  readVerificationDisposition,
  readVerificationView,
  verificationRewardMarks,
  verificationSourceDescription,
  verifyAndAttach,
  type VerificationRunSummary,
  type VerifyAndAttachInput,
  type VerifyAndAttachResult
} from './attach';
export {
  ARTIFACT_DIGEST_SHAPE,
  unregisterAuthenticatedQualityRecord,
  isCompleteQualityBinding,
  missingQualityBindingFields,
  QUALITY_BINDING_FIELDS,
  QUALITY_RECORD_DIGEST_VERSION,
  clearQualityRecordRegistry,
  computeQualityRecordDigest,
  isAuthenticatedQualityRecord,
  qualityProvenanceRegistry,
  registerAuthenticatedQualityRecord,
  type AuthenticatedQualityEntry,
  type QualityProvenanceContext
} from './quality-provenance';
