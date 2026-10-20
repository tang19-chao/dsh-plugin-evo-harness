import { describe, expect, it } from 'vitest';

import {
  HARD_FAILURE_SIGNALS,
  REPAIRABLE_FAILURE_SIGNALS,
  WEAK_FAILURE_SIGNALS,
  classifyFailure,
  createFailureTaxonomy,
  diagnoseFailure,
  isRepairableCategory,
  isTerminalFailure,
  signalFromToolError,
  signalsFromTrajectory
} from '../../../src/dream-rsi/failure-taxonomy';
import {
  makeDiagnosis,
  makeSignal,
  makeToolError,
  makeTrajectory
} from './fixtures';
import type { FailureDiagnosis } from '../../../src/types/contracts';

function repeat(count: number, diagnosis: FailureDiagnosis): FailureDiagnosis[] {
  const out: FailureDiagnosis[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(diagnosis);
  }
  return out;
}

describe('failure taxonomy signals', () => {
  it('maps tool errors onto specific signal kinds', () => {
    expect(signalFromToolError(makeToolError({ message: 'unexpected token }' })).kind).toBe(
      'syntax_error'
    );
    expect(
      signalFromToolError(makeToolError({ message: 'Cannot find module "./helper"' })).kind
    ).toBe('import_error');
    expect(
      signalFromToolError(makeToolError({ code: 'ETIMEDOUT', message: 'socket hang' })).kind
    ).toBe('timeout');
    expect(
      signalFromToolError(makeToolError({ message: 'invalid patch body' })).kind
    ).toBe('invalid_patch');
    expect(signalFromToolError(makeToolError({ message: 'permission denied' })).kind).toBe(
      'tool_error'
    );
  });

  it('collects, dedupes and augments trajectory signals', () => {
    const trajectory = makeTrajectory({
      status: 'timeout',
      toolErrors: [makeToolError({ message: 'unexpected token }' })],
      failureSignals: [makeSignal({ kind: 'no_deliverable', message: 'empty output' })]
    });
    const signals = signalsFromTrajectory(trajectory);
    const kinds = signals.map((signal) => signal.kind);
    expect(kinds).toContain('no_deliverable');
    expect(kinds).toContain('syntax_error');
    expect(kinds).toContain('timeout');
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('exposes the documented signal families', () => {
    expect(HARD_FAILURE_SIGNALS).toContain('model_refusal');
    expect(REPAIRABLE_FAILURE_SIGNALS).toContain('import_error');
    expect(WEAK_FAILURE_SIGNALS).toContain('memory_conflict');
  });
});

describe('failure taxonomy categories', () => {
  it('reports none for a successful probe', () => {
    const diagnosis = diagnoseFailure({
      trajectory: makeTrajectory({ status: 'succeeded' })
    });
    expect(diagnosis.category).toBe('none');
    expect(diagnosis.repairable).toBe(false);
    expect(diagnosis.recommendedAction).toBe('stop');
    expect(diagnosis.confidence).toBeGreaterThan(0.5);
    expect(diagnosis.evidence.join(' ')).toContain('deliverable');
  });

  it('reports none for a scheduled node with no evidence', () => {
    const node = {
      ...makeProbeNode()
    };
    const diagnosis = diagnoseFailure({ node });
    expect(diagnosis.category).toBe('none');
    expect(diagnosis.confidence).toBeLessThan(0.9);
  });

  it('classifies model refusal and aborted runs as hard_unrecoverable', () => {
    const refusal = diagnoseFailure({
      trajectory: makeTrajectory({
        status: 'failed',
        deliverable: null,
        failureSignals: [makeSignal({ kind: 'model_refusal', message: 'policy refusal' })]
      })
    });
    expect(refusal.category).toBe('hard_unrecoverable');
    expect(refusal.recommendedAction).toBe('discard');
    expect(refusal.repairable).toBe(false);
    expect(isTerminalFailure(refusal)).toBe(true);

    const aborted = diagnoseFailure({
      trajectory: makeTrajectory({ status: 'aborted', deliverable: null })
    });
    expect(aborted.category).toBe('hard_unrecoverable');
  });

  it('stops on an exhausted budget', () => {
    const diagnosis = diagnoseFailure({
      trajectory: makeTrajectory({
        status: 'failed',
        deliverable: null,
        failureSignals: [
          makeSignal({ kind: 'budget_exhausted', message: 'rollout budget spent' })
        ]
      })
    });
    expect(diagnosis.category).toBe('hard_unrecoverable');
    expect(diagnosis.recommendedAction).toBe('stop');
  });

  it('classifies broken generated code as repairable_implementation', () => {
    const diagnosis = diagnoseFailure({
      trajectory: makeTrajectory({
        status: 'failed',
        deliverable: null,
        toolErrors: [
          makeToolError({
            toolName: 'mount_plugin',
            message: 'unexpected token }',
            retryable: true
          })
        ]
      })
    });
    expect(diagnosis.category).toBe('repairable_implementation');
    expect(diagnosis.repairable).toBe(true);
    expect(diagnosis.recommendedAction).toBe('repair');
    expect(diagnosis.repairHint).toContain('mount_plugin');
    expect(isRepairableCategory(diagnosis.category)).toBe(true);
    expect(isTerminalFailure(diagnosis)).toBe(false);
  });

  it('classifies missing imports and malformed patches as repairable', () => {
    const importFailure = diagnoseFailure({
      toolErrors: [makeToolError({ message: 'Cannot find module "./x"' })],
      node: makeProbeNode('failed')
    });
    expect(importFailure.category).toBe('repairable_implementation');
    const patchFailure = diagnoseFailure({
      signals: [makeSignal({ kind: 'invalid_patch', message: 'patch schema rejected' })]
    });
    expect(patchFailure.category).toBe('repairable_implementation');
  });

  it('classifies thin evidence as weak_underexplored', () => {
    const diagnosis = diagnoseFailure({
      trajectory: makeTrajectory({
        status: 'failed',
        deliverable: null,
        failureSignals: [makeSignal({ kind: 'no_deliverable', message: 'no output' })]
      }),
      hasUnexploredDirections: true
    });
    expect(diagnosis.category).toBe('weak_underexplored');
    expect(diagnosis.recommendedAction).toBe('deepen');
    expect(diagnosis.repairable).toBe(false);
    expect(diagnosis.evidence.join(' ')).toContain('unexplored directions');
  });

  it('moves elsewhere when memory conflicts or the tree is exhausted', () => {
    const conflict = diagnoseFailure({
      signals: [makeSignal({ kind: 'memory_conflict', message: 'lesson premise false' })]
    });
    expect(conflict.category).toBe('weak_underexplored');
    expect(conflict.recommendedAction).toBe('explore_elsewhere');

    const exhausted = diagnoseFailure({
      trajectory: makeTrajectory({ status: 'failed', deliverable: null }),
      hasUnexploredDirections: false,
      maxDepthReached: true
    });
    expect(exhausted.category).toBe('weak_underexplored');
    expect(exhausted.recommendedAction).toBe('explore_elsewhere');
  });

  it('treats a bare failed probe as under-explored', () => {
    const diagnosis = diagnoseFailure({
      trajectory: makeTrajectory({ status: 'failed', deliverable: null })
    });
    expect(diagnosis.category).toBe('weak_underexplored');
    expect(diagnosis.signals).toEqual([]);
  });

  it('detects repeatedly unpromising lineages from history and attempt counts', () => {
    const repairable = makeDiagnosis('repairable_implementation');
    const fromHistory = diagnoseFailure({
      signals: [makeSignal({ kind: 'tool_error', message: 'still broken' })],
      previousDiagnoses: repeat(3, repairable)
    });
    expect(fromHistory.category).toBe('repeatedly_unpromising');
    expect(fromHistory.recommendedAction).toBe('explore_elsewhere');
    expect(fromHistory.evidence.join(' ')).toContain('prior failures in lineage: 3');

    const notYet = diagnoseFailure({
      trajectory: makeTrajectory({ status: 'failed', deliverable: null }),
      attemptIndex: 3
    });
    expect(notYet.category).toBe('weak_underexplored');

    const fromAttempts = diagnoseFailure({
      trajectory: makeTrajectory({ status: 'failed', deliverable: null }),
      attemptIndex: 4
    });
    expect(fromAttempts.category).toBe('repeatedly_unpromising');

    const explicit = diagnoseFailure({
      signals: [makeSignal({ kind: 'repeated_failure', message: 'third strike' })]
    });
    expect(explicit.category).toBe('repeatedly_unpromising');
    expect(explicit.confidence).toBeGreaterThan(0.5);
  });

  it('honours a custom repeated-failure threshold', () => {
    const repairable = makeDiagnosis('repairable_implementation');
    const one = diagnoseFailure({
      previousDiagnoses: [repairable],
      repeatedFailureThreshold: 1,
      signals: [makeSignal({ kind: 'tool_error', message: 'x' })]
    });
    expect(one.category).toBe('repeatedly_unpromising');
    const two = diagnoseFailure({
      previousDiagnoses: [repairable],
      repeatedFailureThreshold: 2,
      signals: [makeSignal({ kind: 'tool_error', message: 'x' })]
    });
    expect(two.category).toBe('repairable_implementation');
  });

  it('applies a fixed precedence: hard then repeated then repairable then weak', () => {
    const mixed = diagnoseFailure({
      signals: [
        makeSignal({ kind: 'syntax_error', message: 'unexpected token' }),
        makeSignal({ kind: 'model_refusal', message: 'refused' })
      ]
    });
    expect(mixed.category).toBe('hard_unrecoverable');

    const repeated = diagnoseFailure({
      signals: [makeSignal({ kind: 'syntax_error', message: 'unexpected token' })],
      previousDiagnoses: repeat(3, makeDiagnosis('repairable_implementation'))
    });
    expect(repeated.category).toBe('repeatedly_unpromising');
  });

  it('keeps confidence clamped to [0, 1] for every category', () => {
    const categories: FailureDiagnosis[] = [
      diagnoseFailure({ trajectory: makeTrajectory({ status: 'succeeded' }) }),
      diagnoseFailure({
        signals: [makeSignal({ kind: 'model_refusal', message: 'no' })]
      }),
      diagnoseFailure({
        previousDiagnoses: repeat(9, makeDiagnosis('weak_underexplored')),
        signals: [makeSignal({ kind: 'unknown', message: 'hmm' })]
      }),
      diagnoseFailure({
        signals: [makeSignal({ kind: 'syntax_error', message: 'bad' })]
      }),
      diagnoseFailure({ trajectory: makeTrajectory({ status: 'failed', deliverable: null }) }),
      diagnoseFailure({})
    ];
    for (const diagnosis of categories) {
      expect(diagnosis.confidence).toBeGreaterThanOrEqual(0);
      expect(diagnosis.confidence).toBeLessThanOrEqual(1);
    }
    expect(categories.map((entry) => entry.category)).toEqual([
      'none',
      'hard_unrecoverable',
      'repeatedly_unpromising',
      'repairable_implementation',
      'weak_underexplored',
      'none'
    ]);
  });

  it('supports the taxonomy instance and classifyFailure helper', () => {
    const taxonomy = createFailureTaxonomy({ repeatedFailureThreshold: 2 });
    const diagnosis = taxonomy.diagnose({
      signals: [makeSignal({ kind: 'tool_error', message: 'boom' })],
      previousDiagnoses: repeat(2, makeDiagnosis('repairable_implementation'))
    });
    expect(diagnosis.category).toBe('repeatedly_unpromising');
    expect(classifyFailure({}).category).toBe('none');
  });
});

function makeProbeNode(status: 'proposed' | 'scheduled' | 'probing' | 'succeeded' | 'failed' = 'scheduled') {
  return {
    id: 'n1',
    treeId: 't1',
    parentId: null,
    depth: 0,
    branchId: 'b1',
    patchId: 'p1',
    patchOrigin: 'reference' as const,
    purpose: 'initial' as const,
    guidance: 'memory' as const,
    status,
    childIds: [],
    createdAt: 1,
    updatedAt: 1
  };
}
