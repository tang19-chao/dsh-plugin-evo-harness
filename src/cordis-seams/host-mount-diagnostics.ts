/**
 * rev6 audit A5 (B7): the honest diagnostic for a DSH host that carries no
 * branch identity in its hook dispatches.
 *
 * WHY THIS EXISTS
 * ---------------
 * On DSH 0.2.1-rc.5 the hook waterfall delivers `system-prompt/assemble`,
 * `tools/pre-execute`, `tools/post-execute` and `agent/pre-step` with SESSION
 * identity only; no dispatch proves a `branchId` (rc3 measured `branchId=0` in
 * every scenario). A branch-class mount therefore fails closed by design: the
 * probe's scaffold is applied through the prompt / tool executor, never through
 * a hook. Without an explicit diagnostic, a reader could see a mounted-looking
 * status page and assume the host applied the patch inside the branch.
 *
 * THE RULE (pure, structural)
 * ---------------------------
 * Report the exact sentence
 *   `branch-scoped hook mount: unavailable (host dispatch carries no branchId)`
 * only when ALL of the following hold:
 *   1. the adapter in use is the real DSH hook adapter (`dsh-hooks`), not the
 *      injected/structural/in-memory fallbacks;
 *   2. at least one dispatch was OBSERVED (`applied + delegated > 0` across
 *      the four hook events), so the absence of branch proof is a measurement
 *      rather than a mount that never ran;
 *   3. NO branch-class mount ever acted on a branch-proving dispatch
 *      (`branchProofApplied === 0`).
 *
 * This module never changes a mount decision and never throws: it only turns
 * an already-measured fact into a stable sentence + counts. A future host that
 * supplies branch identity will naturally stop matching condition 3.
 */
import type { DshHookAdapterStats } from './dsh-hook-host-adapter';

/** The exact sentence production diagnostics must carry. */
export const BRANCH_SCOPED_HOOK_MOUNT_UNAVAILABLE =
  'branch-scoped hook mount: unavailable (host dispatch carries no branchId)';

/** Structural input: the adapter source and its measured counters. */
export interface HostMountDiagnosticInput {
  readonly hostAdapterSource: string;
  readonly stats?: DshHookAdapterStats | undefined;
}

/** The diagnostic plus the counts it was derived from. */
export interface HostMountUnavailableDiagnostic {
  readonly diagnostic: typeof BRANCH_SCOPED_HOOK_MOUNT_UNAVAILABLE;
  /** Total dispatches observed across the four hook events. */
  readonly dispatches: number;
  /** Branch-class mounts that acted on a branch-proving dispatch (must be 0). */
  readonly branchProofApplied: number;
  /** One-line observation with the counts, for the operator log. */
  readonly summary: string;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Derive the diagnostic, or `undefined` when the host either is not the real
 * hook adapter or has proven branch identity is available.
 */
export function diagnoseBranchScopedHookMount(
  input: HostMountDiagnosticInput
): HostMountUnavailableDiagnostic | undefined {
  if (input.hostAdapterSource !== 'dsh-hooks') {
    return undefined;
  }
  const stats = input.stats;
  if (stats === undefined) {
    return undefined;
  }
  const counters = [stats.assemble, stats.preExecute, stats.postExecute, stats.preStep];
  const dispatches = counters.reduce(
    (total, counter) =>
      total + numberOrZero(counter?.applied) + numberOrZero(counter?.delegated),
    0
  );
  const branchProofApplied = [
    stats.scope?.assemble,
    stats.scope?.preExecute,
    stats.scope?.postExecute,
    stats.scope?.preStep
  ].reduce((total, scope) => total + numberOrZero(scope?.branchProofApplied), 0);
  if (dispatches === 0 || branchProofApplied > 0) {
    return undefined;
  }
  return {
    diagnostic: BRANCH_SCOPED_HOOK_MOUNT_UNAVAILABLE,
    dispatches,
    branchProofApplied,
    summary:
      'branch-scoped hook mount observation: dispatches=' +
      String(dispatches) +
      ', branchProofApplied=0 (the host waterfall never proves a branchId; probe scaffolds are applied through the prompt/tool executor, not hooks)'
  };
}