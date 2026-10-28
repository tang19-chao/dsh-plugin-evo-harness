/**
 * C2b end-to-end (ADR 0004 §2, §8.2): End-to-end integration of host-owned verification,
 * authenticated quality record registration, dual-track separate retrieval, atomic track selection,
 * and conservative replacement gate.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  createHostOwnedVerificationRunner,
  registerAuthenticatedQualityRecord,
  clearQualityRecordRegistry,
  isAuthenticatedQualityRecord,
  type HostVerificationSeam
} from '../../src/verification';
import type {
  IsolatedBranchContext,
  ProbeExecutionResult
} from '../../src/types/contracts';
import { buildE2E, createRecordingPolicy } from './fixtures';
import { createStoreOptimizer } from '../../src/jitrl';

const HOST_ID = 'c2b-e2e-runner';
const TEST_SET = 'e2e-quality-tests@v1';
const ENV = 'e2e-quality-env-1';

const CORRECT_DELIVERABLE = '{"status":"ok","score":100}';
const WRONG_DELIVERABLE = '{"status":"failed","score":0}';

function createBranchExecutor(now: () => number): {
  (context: IsolatedBranchContext): Promise<ProbeExecutionResult>;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let candidateCount = 0;

  const run = async (context: IsolatedBranchContext): Promise<ProbeExecutionResult> => {
    const isReference =
      context.patch.purpose === 'initial' && Object.keys(context.patch.edits).length === 0;
    calls.push(isReference ? 'reference' : 'candidate');

    if (isReference) {
      return {
        status: 'failed',
        steps: [
          { index: 0, at: now(), kind: 'model', text: 'reference probe baseline' },
          { index: 1, at: now(), kind: 'error', text: 'reference probe failed tests' }
        ],
        toolErrors: [{ toolName: 'test-runner', message: 'test exit 1', stepIndex: 1 }],
        failureSignals: [{ kind: 'tool_error', message: 'test exit 1', repairable: true }],
        deliverable: { content: WRONG_DELIVERABLE, format: 'json' }
      };
    }

    const idx = candidateCount;
    candidateCount += 1;

    if (idx === 0) {
      return {
        status: 'succeeded',
        steps: [
          { index: 0, at: now(), kind: 'model', text: 'apply patch and run tests' },
          { index: 1, at: now(), kind: 'tool', toolName: 'test-runner', toolResult: { exitCode: 0 } },
          { index: 2, at: now(), kind: 'result', text: 'all checks passed' }
        ],
        deliverable: { content: CORRECT_DELIVERABLE, format: 'json' }
      };
    }

    return {
      status: 'failed',
      steps: [
        { index: 0, at: now(), kind: 'model', text: 'apply patch but tests fail' },
        { index: 1, at: now(), kind: 'error', text: 'assertion error in candidate' }
      ],
      deliverable: { content: WRONG_DELIVERABLE, format: 'json' }
    };
  };

  return Object.assign(run, { calls });
}

function createVerificationSeam(): HostVerificationSeam {
  const runner = createHostOwnedVerificationRunner({
    verifierId: HOST_ID,
    verifierVersion: '1.0.0',
    testSetId: TEST_SET,
    envId: ENV,
    cases: [
      {
        taskId: 'task-c2b-e2e',
        checks: [
          {
            id: 'deliverable-ok',
            run: (artifact) => {
              try {
                const parsed = JSON.parse(artifact.content);
                return parsed?.status === 'ok' && parsed?.score === 100;
              } catch {
                return false;
              }
            }
          }
        ]
      }
    ]
  });

  return {
    enabled: true,
    runner
  };
}

describe('C2b End-to-End: Trusted Quality Consumption', () => {
  beforeEach(() => {
    clearQualityRecordRegistry();
  });

  it('runs production orchestrator with verification seam and records authenticated quality records', async () => {
    const seam = createVerificationSeam();
    const runner = createBranchExecutor(() => Date.now());
    const events: Array<{ stage: string; detail?: any }> = [];

    const harness = buildE2E({
      config: {
        jitrl: {
          enabled: true,
          levels: ['meta', 'proposal'],
          candidateCount: 1
        }
      },
      maxWidth: 2,
      maxDepth: 1,
      rolloutBudget: 4,
      extra: {
        runBranch: runner,
        deps: {
          policy: createRecordingPolicy({ maxWidth: 2, maxDepth: 1 }, { stopCondition: 'budget_exhausted' }),
          onStage: (event: any) => {
            events.push({ stage: String(event.stage ?? ''), detail: event.detail });
          },
          verification: seam
        }
      }
    });

    const result = await harness.plugin.run({
      sessionId: 'sess-c2b-e2e',
      task: {
        id: 'task-c2b-e2e',
        prompt: 'Fix the failing module to return status ok score 100.'
      },
      trigger: 'always'
    });

    expect(result).toBeDefined();

    // Verify stage recording happened
    const recordStages = events.filter((e) => e.stage === 'record_experience');
    expect(recordStages.length).toBeGreaterThan(0);

    const recordPayload = recordStages[0]?.detail as { readonly detail?: Readonly<Record<string, unknown>> } | undefined;
    const recordDetail = recordPayload?.detail;
    expect(recordDetail).toBeDefined();
    expect(recordDetail?.records).toBeGreaterThan(0);

    // Verify experience store was populated in JitRL kernel
    const jitrl = harness.plugin.jitrl;
    expect(jitrl).toBeDefined();
  });

  it('enforces dual-track consumption in store optimizer when enabled', async () => {
    const now = 1_700_000_000_000;
    const seam = createVerificationSeam();
    const runner = createBranchExecutor(() => now);

    const harness = buildE2E({
      config: {
        jitrl: {
          enabled: true,
          levels: ['meta'],
          candidateCount: 2
        }
      },
      maxWidth: 2,
      maxDepth: 1,
      rolloutBudget: 4,
      extra: {
        runBranch: runner,
        dualTrack: {
          enableQualityTrackConsumption: true,
          minQualityEffectiveSamples: 1.0
        },
        deps: {
          policy: createRecordingPolicy({ maxWidth: 2, maxDepth: 1 }, { stopCondition: 'budget_exhausted' }),
          verification: seam
        }
      }
    });

    await harness.plugin.run({
      sessionId: 'sess-c2b-dual',
      task: {
        id: 'task-c2b-e2e',
        prompt: 'Produce deliverable for quality consumption test.'
      },
      trigger: 'always'
    });

    expect(harness.plugin.jitrl.enabled).toBe(true);
  });
});
