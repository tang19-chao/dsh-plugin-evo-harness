/**
 * C2a (ADR 0003 §4.1/§4.7): the host-owned deterministic local verifier runner.
 *
 * Properties this module guarantees, by construction:
 *   - SOURCE, not shape: a receipt only exists if THIS instance produced it and
 *     registered it under `(runId, trajectoryId, role)`. `attach.ts` additionally
 *     requires object identity with the registry entry, so a self-declared
 *     payload can never become trusted (T1/T2).
 *   - HOST digest: the evidence hash is recomputed here from the artifact bytes
 *     (T3); the caller cannot inject one.
 *   - BINDING: every receipt carries the full `taskId/testSetId/envId/runId` +
 *     trajectory identity (T4).
 *   - DETERMINISM: the same artifact + case + env always yields the same digest
 *     and verdict; first write wins per trajectory (ADR §4.7).
 *   - NO side channels: pure in-process checks, no network, no model, no memory,
 *     no patch/publish (T6). A check that throws cannot produce a receipt - it
 *     degrades to `runner-error` instead of forging a "trusted failure".
 */
import { artifactDigestOf } from './artifact-digest';
import {
  HOST_VERIFICATION_KIND,
  type HostArtifact,
  type HostVerificationReceipt,
  type HostVerificationRequest,
  type HostVerificationRunner,
  type HostVerificationRunnerOutcome,
  type VerificationReasonCode
} from './types';

/** One deterministic check over the artifact bytes. */
export interface HostVerificationCheck {
  readonly id: string;
  /** Must be pure and deterministic; returning true means "this check passed". */
  readonly run: (artifact: HostArtifact) => boolean;
}

/**
 * One host-registered case. `taskId` is the case key: a task without a
 * registered case cannot be verified (refused as `no-runner`, i.e. "no runner
 * able to serve this request"), never guessed.
 */
export interface HostVerificationCase {
  readonly taskId: string;
  readonly checks: readonly HostVerificationCheck[];
}

export interface HostOwnedVerificationRunnerOptions {
  /** Stable producer identity; the only id this instance can authenticate. */
  readonly verifierId: string;
  readonly verifierVersion: string;
  /** Test-set version shared by reference and candidate runs (ADR §4.4). */
  readonly testSetId: string;
  /** Environment identity shared by reference and candidate runs (ADR §4.4). */
  readonly envId: string;
  readonly cases: readonly HostVerificationCase[];
}

interface RegisteredReceipt {
  readonly digest: string;
  readonly receipt: HostVerificationReceipt;
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('host verification runner: ' + field + ' must be a non-empty string');
  }
  return value;
}

function registryKey(runId: string, trajectoryId: string, role: string): string {
  return runId + '\u0000' + trajectoryId + '\u0000' + role;
}

/**
 * Build the host runner. Construction validates the static contract so a
 * misconfigured runner fails loudly at assembly time instead of silently
 * degrading every probe to audit-only.
 */
export function createHostOwnedVerificationRunner(
  options: HostOwnedVerificationRunnerOptions
): HostVerificationRunner {
  const verifierId = requireNonEmpty(options.verifierId, 'verifierId');
  const verifierVersion = requireNonEmpty(options.verifierVersion, 'verifierVersion');
  const testSetId = requireNonEmpty(options.testSetId, 'testSetId');
  const envId = requireNonEmpty(options.envId, 'envId');
  if (!Array.isArray(options.cases) || options.cases.length === 0) {
    throw new TypeError('host verification runner: at least one case is required');
  }
  const cases = new Map<string, readonly HostVerificationCheck[]>();
  for (const entry of options.cases) {
    const taskId = requireNonEmpty(entry.taskId, 'case.taskId');
    if (cases.has(taskId)) {
      throw new TypeError('host verification runner: duplicate case for task ' + taskId);
    }
    if (!Array.isArray(entry.checks) || entry.checks.length === 0) {
      // An empty check list cannot establish a verdict; refusing at
      // construction keeps "empty checks" structurally impossible to attach.
      throw new TypeError(
        'host verification runner: case ' + taskId + ' must declare at least one check'
      );
    }
    const ids = new Set<string>();
    for (const check of entry.checks) {
      const id = requireNonEmpty(check.id, 'check.id');
      if (ids.has(id)) {
        throw new TypeError('host verification runner: duplicate check ' + id + ' in case ' + taskId);
      }
      ids.add(id);
    }
    cases.set(taskId, [...entry.checks]);
  }

  const registry = new Map<string, RegisteredReceipt>();
  const trustedProducers: ReadonlySet<string> = new Set<string>([verifierId]);

  const refuse = (
    reasonCode: VerificationReasonCode,
    reason: string
  ): HostVerificationRunnerOutcome => ({ reasonCode, reason });

  async function verify(request: HostVerificationRequest): Promise<HostVerificationRunnerOutcome> {
    const runId = requireNonEmpty(request.runId, 'request.runId');
    const trajectoryId = requireNonEmpty(request.trajectoryId, 'request.trajectoryId');
    const taskId = requireNonEmpty(request.taskId, 'request.taskId');
    const artifact = request.artifact;
    if (artifact === undefined) {
      return refuse(
        'artifact-missing',
        'no artifact to verify (missing deliverable, or empty content with no produced files)'
      );
    }
    const checks = cases.get(taskId);
    if (checks === undefined) {
      return refuse(
        'no-runner',
        'no host case registered for task ' + taskId + ' (this runner cannot verify it)'
      );
    }
    const digest = artifactDigestOf(artifact);
    const key = registryKey(runId, trajectoryId, request.role);
    const existing = registry.get(key);
    if (existing !== undefined) {
      if (existing.digest !== digest) {
        // ADR §4.7: first write wins. The receipt bound to this trajectory
        // refers to an EARLIER artifact; the artifact presented now is not the
        // one that was verified, so it must not be attached as trusted.
        return {
          receipt: existing.receipt,
          reasonCode: 'stale-artifact',
          reason:
            'the receipt registered for this trajectory was computed over an earlier artifact digest'
        };
      }
      return { receipt: existing.receipt, duplicate: true };
    }

    const results: { readonly id: string; readonly passed: boolean }[] = [];
    for (const check of checks) {
      let passed: boolean;
      try {
        passed = check.run(artifact) === true;
      } catch (error) {
        // A check that could not run says NOTHING about task quality: no
        // receipt is produced (never a forged trusted failure).
        const message = error instanceof Error ? error.message : String(error);
        return refuse('runner-error', 'host check ' + check.id + ' failed to run: ' + message);
      }
      results.push({ id: check.id, passed });
    }
    const status: 'passed' | 'failed' = results.every((entry) => entry.passed) ? 'passed' : 'failed';
    const receipt: HostVerificationReceipt = {
      status,
      verifierId,
      verifierVersion,
      evidenceHash: digest,
      checks: results,
      verificationId: verifierId + '@' + verifierVersion + '#' + runId + '#' + trajectoryId,
      binding: {
        runId,
        sessionId: request.sessionId,
        trajectoryId,
        role: request.role,
        taskId,
        testSetId,
        envId,
        artifactDigest: digest
      },
      kind: HOST_VERIFICATION_KIND
    };
    registry.set(key, { digest, receipt });
    return { receipt };
  }

  return {
    verifierId,
    verifierVersion,
    testSetId,
    envId,
    trustedProducers,
    verify,
    receiptFor(runId: string, trajectoryId: string, role): HostVerificationReceipt | undefined {
      return registry.get(registryKey(runId, trajectoryId, role))?.receipt;
    },
    get size(): number {
      return registry.size;
    }
  };
}
