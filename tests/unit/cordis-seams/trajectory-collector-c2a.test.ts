/**
 * C2a (ADR 0003 §4.1/§4.2): the collector is NOT a trust channel.
 *
 * `TrajectoryCollector.finalize` drops `ProbeExecutionResult.metadata` (it only
 * writes its own diagnostics), so a branch executor cannot attach a verdict to
 * its own result. The host receipt can only be added by the attach side, which
 * rewrites the metadata bag. These tests pin both halves, using the real
 * collector and the real attach path.
 */
import { describe, expect, it } from 'vitest';
import { TrajectoryCollector } from '../../../src/cordis-seams/trajectory-collector';
import {
  createHostOwnedVerificationRunner,
  readVerificationView,
  verifyAndAttach
} from '../../../src/verification';
import type { EightSurfacePatch } from '../../../src/types/contracts';

const patch = {
  id: 'patch-collector',
  origin: 'domain',
  label: 'collector-probe'
} as unknown as EightSurfacePatch;

function collector(): TrajectoryCollector {
  return new TrajectoryCollector({
    id: 'traj-collector',
    sessionId: 'sess-collector',
    branchId: 'branch',
    branchNamespace: 'ns',
    role: 'candidate',
    patch,
    now: () => 0
  });
}

describe('c2a: the result metadata bag is not a verdict channel', () => {
  it('finalize drops a branch-declared verification payload and never invents a contentHash', () => {
    const trajectory = collector().finalize({
      status: 'succeeded',
      endedAt: 10,
      result: {
        status: 'succeeded',
        deliverable: { content: '{"ok":true,"value":42}', format: 'json' },
        metadata: {
          verification: {
            status: 'passed',
            verifierId: 'c2a-verifier',
            verifierVersion: '1.0.0',
            evidenceHash: 'sha256:forged',
            checks: [{ id: 'json-ok', passed: true }]
          },
          branchNote: 'kept?'
        }
      } as never
    });
    // The collector keeps its own diagnostics metadata only.
    expect(trajectory.metadata?.['verification']).toBeUndefined();
    expect(trajectory.metadata?.['branchNote']).toBeUndefined();
    // The deliverable came through unhashed: the HOST must digit it (T3).
    expect(trajectory.deliverable?.content).toBe('{"ok":true,"value":42}');
    expect(trajectory.deliverable?.contentHash).toBeUndefined();
    expect(readVerificationView(trajectory)).toBeUndefined();
  });

  it('the host attach then binds an authenticated receipt to that same trajectory', async () => {
    const trajectory = collector().finalize({
      status: 'succeeded',
      endedAt: 10,
      result: {
        status: 'succeeded',
        deliverable: { content: '{"ok":true,"value":42}', format: 'json' },
        metadata: { verification: { status: 'failed', verifierId: 'branch-lier' } }
      } as never
    });
    const host = createHostOwnedVerificationRunner({
      verifierId: 'c2a-verifier',
      verifierVersion: '1.0.0',
      testSetId: 'tests@v1',
      envId: 'env-local-1',
      cases: [
        {
          taskId: 'task-collector',
          checks: [
            {
              id: 'json-ok',
              run: (artifact) => JSON.parse(artifact.content)['ok'] === true
            }
          ]
        }
      ]
    });
    const { trajectory: verified, disposition } = await verifyAndAttach({
      seam: { runner: host },
      trajectory,
      runId: 'run-collector',
      taskId: 'task-collector'
    });
    expect(disposition?.attached).toBe(true);
    expect(disposition?.authenticated).toBe(true);
    expect(disposition?.verdict).toBe('passed');
    const view = readVerificationView(verified);
    expect(view?.receipt?.verifierId).toBe('c2a-verifier');
    expect(verified.deliverable?.contentHash).toBe(view?.receipt?.evidenceHash);
    // The trajectory object the run continues with is a new, immutable value.
    expect(verified).not.toBe(trajectory);
    expect(trajectory.metadata?.['verification']).toBeUndefined();
  });
});
