/**
 * C2a (ADR 0003 §4.1/§4.7): the host-owned verification runner contract.
 *
 * The runner is the ONLY thing that may create a receipt. These tests pin:
 *   - host-recomputed digest (T3) and full binding (T4);
 *   - determinism and first-write-wins (stale-artifact on a changed artifact,
 *     duplicate on an identical re-verification);
 *   - fail-closed refusals: missing artifact, unknown task, throwing check
 *     (never a forged "trusted failure");
 *   - construction-time refusal of empty check lists;
 *   - zero side channels: no network, no model, no memory/patch/publish imports.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { artifactDigestOf, artifactOf } from '../../../src/verification/artifact-digest';
import {
  createHostOwnedVerificationRunner,
  type HostVerificationCheck
} from '../../../src/verification/host-runner';
import type { ProbeTrajectory } from '../../../src/types/contracts';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function trajectory(overrides: Partial<ProbeTrajectory> = {}): ProbeTrajectory {
  return {
    id: 'traj-runner',
    sessionId: 'sess-runner',
    branchId: 'branch',
    branchNamespace: 'ns',
    role: 'candidate',
    status: 'succeeded',
    patchId: 'p',
    patchOrigin: 'domain',
    surfaceKeys: [],
    startedAt: 0,
    endedAt: 10,
    metrics: { steps: 2, toolCalls: 1, toolErrors: 0, durationMs: 10 },
    steps: [],
    toolErrors: [],
    failureSignals: [],
    memoryRecallIds: [],
    deliverable: { content: '{"ok":true,"value":42}', format: 'json' },
    ...overrides
  } as ProbeTrajectory;
}

/** A real, deterministic check: the artifact must be JSON with ok === true. */
const jsonOkCheck: HostVerificationCheck = {
  id: 'json-ok',
  run: (artifact) => {
    const parsed: unknown = JSON.parse(artifact.content);
    return (
      parsed !== null && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === true
    );
  }
};

function runner(): ReturnType<typeof createHostOwnedVerificationRunner> {
  return createHostOwnedVerificationRunner({
    verifierId: 'c2a-verifier',
    verifierVersion: '1.0.0',
    testSetId: 'tests@v1',
    envId: 'env-local-1',
    cases: [{ taskId: 'task-c2a', checks: [jsonOkCheck] }]
  });
}

describe('c2a host runner: digests and receipts', () => {
  it('recomputes the digest from the artifact and binds task/test-set/env/run', async () => {
    const host = runner();
    const artifact = { content: '{"ok":true,"value":42}', producedFiles: [] };
    const outcome = await host.verify({
      runId: 'run-1',
      sessionId: 'sess-runner',
      trajectoryId: 'traj-runner',
      role: 'candidate',
      taskId: 'task-c2a',
      executionStatus: 'succeeded',
      artifact
    });
    expect(outcome.reasonCode).toBeUndefined();
    const receipt = outcome.receipt;
    expect(receipt).toBeDefined();
    expect(receipt?.status).toBe('passed');
    expect(receipt?.evidenceHash).toBe(artifactDigestOf(artifact));
    expect(receipt?.binding).toEqual({
      runId: 'run-1',
      sessionId: 'sess-runner',
      trajectoryId: 'traj-runner',
      role: 'candidate',
      taskId: 'task-c2a',
      testSetId: 'tests@v1',
      envId: 'env-local-1',
      artifactDigest: artifactDigestOf(artifact)
    });
    expect(receipt?.checks).toEqual([{ id: 'json-ok', passed: true }]);
    expect(receipt?.kind).toBe('host-runner');
    expect(receipt?.verificationId).toBe('c2a-verifier@1.0.0#run-1#traj-runner');
    expect(host.trustedProducers.has('c2a-verifier')).toBe(true);
    expect(host.size).toBe(1);
  });

  it('a genuinely wrong artifact gets a failed verdict, not an error', async () => {
    const host = runner();
    const outcome = await host.verify({
      runId: 'run-1',
      sessionId: 's',
      trajectoryId: 'traj-wrong',
      role: 'candidate',
      taskId: 'task-c2a',
      executionStatus: 'succeeded',
      artifact: { content: '{"ok":false,"value":0}', producedFiles: [] }
    });
    expect(outcome.receipt?.status).toBe('failed');
    expect(outcome.receipt?.checks).toEqual([{ id: 'json-ok', passed: false }]);
  });

  it('is deterministic: same artifact/test-set/env => deep-equal digest and verdict', async () => {
    const first = runner();
    const second = runner();
    const request = {
      runId: 'run-x',
      sessionId: 's',
      trajectoryId: 'traj-det',
      role: 'candidate' as const,
      taskId: 'task-c2a',
      executionStatus: 'succeeded' as const,
      artifact: { content: '{"ok":true}', producedFiles: [] }
    };
    const a = await first.verify(request);
    const b = await second.verify(request);
    expect(a.receipt).toEqual(b.receipt);
  });

  it('first write wins: a changed artifact for the same trajectory is stale-artifact', async () => {
    const host = runner();
    const base = {
      runId: 'run-2',
      sessionId: 's',
      trajectoryId: 'traj-stale',
      role: 'candidate' as const,
      taskId: 'task-c2a',
      executionStatus: 'succeeded' as const
    };
    const good = await host.verify({ ...base, artifact: { content: '{"ok":true}', producedFiles: [] } });
    const later = await host.verify({ ...base, artifact: { content: '{"ok":false}', producedFiles: [] } });
    expect(good.receipt?.status).toBe('passed');
    expect(later.reasonCode).toBe('stale-artifact');
    expect(later.receipt).toBe(good.receipt);
    expect(host.size).toBe(1);
  });

  it('an identical re-verification is idempotent (duplicate, same receipt object)', async () => {
    const host = runner();
    const base = {
      runId: 'run-3',
      sessionId: 's',
      trajectoryId: 'traj-dup',
      role: 'candidate' as const,
      taskId: 'task-c2a',
      executionStatus: 'succeeded' as const,
      artifact: { content: '{"ok":true}', producedFiles: [] }
    };
    const first = await host.verify(base);
    const second = await host.verify(base);
    expect(second.duplicate).toBe(true);
    expect(second.receipt).toBe(first.receipt);
    expect(second.reasonCode).toBeUndefined();
  });

  it('the same artifact under a different run is a different registry entry', async () => {
    const host = runner();
    const base = {
      sessionId: 's',
      trajectoryId: 'traj-cross-run',
      role: 'candidate' as const,
      taskId: 'task-c2a',
      executionStatus: 'succeeded' as const,
      artifact: { content: '{"ok":true}', producedFiles: [] }
    };
    const runA = await host.verify({ ...base, runId: 'run-A' });
    const runB = await host.verify({ ...base, runId: 'run-B' });
    expect(runB.duplicate).toBeUndefined();
    expect(runB.receipt?.binding.runId).toBe('run-B');
    expect(host.receiptFor('run-A', 'traj-cross-run', 'candidate')).toBe(runA.receipt);
    expect(host.size).toBe(2);
  });
});

describe('c2a host runner: fail-closed refusals', () => {
  it('refuses a missing artifact as artifact-missing (no receipt)', async () => {
    const host = runner();
    const outcome = await host.verify({
      runId: 'run-1',
      sessionId: 's',
      trajectoryId: 'traj-none',
      role: 'candidate',
      taskId: 'task-c2a',
      executionStatus: 'succeeded',
      artifact: undefined
    });
    expect(outcome.receipt).toBeUndefined();
    expect(outcome.reasonCode).toBe('artifact-missing');
  });

  it('refuses an unregistered task instead of guessing a verdict', async () => {
    const host = runner();
    const outcome = await host.verify({
      runId: 'run-1',
      sessionId: 's',
      trajectoryId: 'traj-unknown-task',
      role: 'candidate',
      taskId: 'task-not-registered',
      executionStatus: 'succeeded',
      artifact: { content: '{"ok":true}', producedFiles: [] }
    });
    expect(outcome.receipt).toBeUndefined();
    expect(outcome.reasonCode).toBe('no-runner');
    expect(host.size).toBe(0);
  });

  it('a throwing check degrades to runner-error: never a forged trusted failure', async () => {
    const host = createHostOwnedVerificationRunner({
      verifierId: 'c2a-verifier',
      verifierVersion: '1.0.0',
      testSetId: 'tests@v1',
      envId: 'env-local-1',
      cases: [
        {
          taskId: 'task-boom',
          checks: [
            {
              id: 'explodes',
              run: () => {
                throw new Error('check infrastructure broke');
              }
            }
          ]
        }
      ]
    });
    const outcome = await host.verify({
      runId: 'run-1',
      sessionId: 's',
      trajectoryId: 'traj-boom',
      role: 'candidate',
      taskId: 'task-boom',
      executionStatus: 'succeeded',
      artifact: { content: '{"ok":true}', producedFiles: [] }
    });
    expect(outcome.receipt).toBeUndefined();
    expect(outcome.reasonCode).toBe('runner-error');
    expect(outcome.reason).toContain('check infrastructure broke');
    expect(host.size).toBe(0);
  });

  it('refuses a case with no checks at construction (empty checks are impossible)', () => {
    expect(() =>
      createHostOwnedVerificationRunner({
        verifierId: 'v',
        verifierVersion: '1',
        testSetId: 't',
        envId: 'e',
        cases: [{ taskId: 'task-empty', checks: [] }]
      })
    ).toThrow(/at least one check/);
  });

  it('refuses duplicate cases, duplicate check ids and empty identities', () => {
    const base = {
      verifierId: 'v',
      verifierVersion: '1',
      testSetId: 't',
      envId: 'e'
    };
    expect(() =>
      createHostOwnedVerificationRunner({
        ...base,
        cases: [
          { taskId: 'dup', checks: [jsonOkCheck] },
          { taskId: 'dup', checks: [jsonOkCheck] }
        ]
      })
    ).toThrow(/duplicate case/);
    expect(() =>
      createHostOwnedVerificationRunner({
        ...base,
        cases: [
          {
            taskId: 'dup-check',
            checks: [jsonOkCheck, jsonOkCheck]
          }
        ]
      })
    ).toThrow(/duplicate check/);
    expect(() =>
      createHostOwnedVerificationRunner({ ...base, verifierId: '', cases: [{ taskId: 't', checks: [jsonOkCheck] }] })
    ).toThrow(/verifierId/);
    expect(() =>
      createHostOwnedVerificationRunner({ ...base, cases: [] })
    ).toThrow(/at least one case/);
  });
});

describe('c2a host runner: artifact extraction and side channels', () => {
  it('artifactOf treats a missing/empty deliverable as no artifact', () => {
    expect(artifactOf(trajectory({ deliverable: undefined }))).toBeUndefined();
    expect(artifactOf(trajectory({ deliverable: { content: '', format: 'text' } }))).toBeUndefined();
    expect(
      artifactOf(trajectory({ deliverable: { content: '', format: 'text', producedFiles: ['a.ts'] } }))
    ).toEqual({ content: '', producedFiles: ['a.ts'] });
  });

  it('the digest is order-insensitive over produced files and sensitive to content', () => {
    const a = artifactDigestOf({ content: 'x', producedFiles: ['b', 'a'] });
    const b = artifactDigestOf({ content: 'x', producedFiles: ['a', 'b'] });
    const c = artifactDigestOf({ content: 'y', producedFiles: ['a', 'b'] });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(a.startsWith('sha256:')).toBe(true);
    expect(a).toHaveLength('sha256:'.length + 64);
  });

  it('the module has no network/model/permission side channels (static scan)', () => {
    const sources = [
      'src/verification/host-runner.ts',
      'src/verification/artifact-digest.ts',
      'src/verification/attach.ts',
      'src/verification/types.ts'
    ];
    for (const rel of sources) {
      const text = readFileSync(REPO_ROOT + rel, 'utf8');
      for (const forbidden of [
        'fetch(',
        'node:http',
        'node:https',
        'node:net',
        'IModelAdapter',
        'memory.commit',
        'applyPermanentPatch',
        'publish('
      ]) {
        expect(text.includes(forbidden), rel + ' must not reference ' + forbidden).toBe(false);
      }
    }
  });
});
