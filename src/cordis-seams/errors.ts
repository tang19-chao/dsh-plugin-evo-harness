/**
 * Typed errors for the Cordis eight-surface seam layer.
 *
 * Every failure mode that downstream modules may need to branch on is a stable
 * code string, so harness2/dream-rsi can discriminate failure taxonomy input
 * without string matching on messages.
 */
import type { HarnessComponentKey } from '../types/contracts';

/** Stable error codes emitted by the seam layer. */
export const CORDIS_SEAM_ERROR_CODES = [
  'invalid_request',
  'invalid_surface_edit',
  'surface_kind_mismatch',
  'seam_unavailable',
  'surface_mount_failed',
  'branch_setup_failed',
  'branch_limit_exceeded',
  'branch_timeout',
  'branch_aborted',
  'permanent_patch_conflict',
  'permanent_mount_failed',
  'registry_disposed',
  'dispose_failed',
  'manager_disposed',
  'mount_scope_not_authorized'
] as const;
export type CordisSeamErrorCode = (typeof CORDIS_SEAM_ERROR_CODES)[number];

/** Constructor options shared by every seam-layer error. */
export interface CordisSeamErrorOptions {
  readonly code: CordisSeamErrorCode;
  readonly surface?: HarnessComponentKey;
  readonly branchId?: string;
  readonly patchId?: string;
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Base error for the Cordis seam layer. */
export class CordisSeamError extends Error {
  readonly code: CordisSeamErrorCode;
  readonly surface: HarnessComponentKey | undefined;
  readonly branchId: string | undefined;
  readonly patchId: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(message: string, options: CordisSeamErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CordisSeamError';
    this.code = options.code;
    this.surface = options.surface;
    this.branchId = options.branchId;
    this.patchId = options.patchId;
    this.details = options.details;
  }
}

/** Raised when a probe branch exceeds its wall-clock budget. */
export class CordisSeamTimeoutError extends CordisSeamError {
  constructor(message: string, options: Omit<CordisSeamErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'branch_timeout' });
    this.name = 'CordisSeamTimeoutError';
  }
}

/** Raised when a probe branch is cancelled by its caller. */
export class CordisSeamAbortError extends CordisSeamError {
  constructor(message: string, options: Omit<CordisSeamErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'branch_aborted' });
    this.name = 'CordisSeamAbortError';
  }
}
