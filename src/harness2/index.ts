/**
 * Harness² propose-probe-compose support module.
 *
 * Exposes the dual-track proposer, the anonymous behavioral composer and the
 * evidence-chain reflector, all implementable against the frozen contracts in
 * src/types/contracts.ts. The probe itself (isolated branch execution) belongs
 * to src/cordis-seams/**; this module never imports a host or MCP package.
 */

export {
  Harness2ProposalError,
  createDualTrackProposer,
  decideProposalGuidance,
  purposeForSlot,
  renderProposalPrompts
} from './proposer';
export type { Harness2ProposalFailure, HarnessProposerOptions, ProposalGuidanceDecision } from './proposer';

export {
  CONTRAST_DIMENSIONS,
  DEFAULT_ADOPTION_BLEND,
  DEFAULT_CONTRAST_WEIGHTS,
  computeBehavioralContrasts,
  createAnonymousComposer,
  scoreCandidateEvidence
} from './composer';
export type { HarnessComposerOptions } from './composer';

export { createEvidenceReflector } from './reflector';
export type { HarnessReflectorOptions } from './reflector';

export type { Clock, IdFactory } from './shared';
export {
  clamp01,
  createDeterministicIdFactory,
  deliverableOf,
  extractJsonValue,
  hashString,
  redactIdentifiers,
  stableStringify,
  summarizeTrajectorySteps,
  surfaceEditSummary,
  surfaceKeysInOrder,
  systemClock,
  truncate
} from './shared';
