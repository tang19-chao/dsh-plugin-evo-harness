/**
 * rev6 audit A5 (B7): branch-scoped hook mount diagnostic.
 *
 * The helper must be a pure, measurement-only derivation:
 *   - not the real hook adapter -> no claim;
 *   - no observed dispatch -> no claim (absence of evidence is not evidence);
 *   - some branch proof applied -> no claim (the host can carry branchId);
 *   - otherwise -> the EXACT stable sentence + counts.
 */
import { describe, expect, it } from 'vitest';
import {
  BRANCH_SCOPED_HOOK_MOUNT_UNAVAILABLE,
  diagnoseBranchScopedHookMount
} from '../../../src/cordis-seams/host-mount-diagnostics';
import type { DshHookAdapterStats } from '../../../src/cordis-seams';

function statsOf(options: {
  readonly applied?: number;
  readonly delegated?: number;
  readonly branchProofApplied?: number;
  readonly allHooksBranchProof?: number;
}): DshHookAdapterStats {
  const counter = (applied: number, delegated: number) => ({ applied, delegated });
  const scope = (branchProofApplied: number) => ({
    applied: 0,
    delegated: 0,
    branchProofApplied,
    sessionOnlySuppressed: 0,
    anonymousSuppressed: 0
  });
  return {
    assemble: counter(options.applied ?? 0, options.delegated ?? 0),
    preExecute: counter(0, 0),
    postExecute: counter(0, 0),
    preStep: counter(0, 0),
    deniedToolCalls: 0,
    installFailures: [],
    scope: {
      assemble: scope(options.branchProofApplied ?? 0),
      preExecute: scope(0),
      postExecute: scope(0),
      preStep: scope(0),
      legacyHostLocalMounts: 0,
      deniedRulesSuppressed: 0
    },
    toolFace: { decisions: 0, denials: 0 },
    surfaceMounts: []
  };
}

describe('diagnoseBranchScopedHookMount', () => {
  it('reports the exact sentence after a branchless dispatch', () => {
    const diagnosis = diagnoseBranchScopedHookMount({
      hostAdapterSource: 'dsh-hooks',
      stats: statsOf({ applied: 1, delegated: 2 })
    });
    expect(diagnosis).toBeDefined();
    expect(diagnosis?.diagnostic).toBe(BRANCH_SCOPED_HOOK_MOUNT_UNAVAILABLE);
    expect(diagnosis?.diagnostic).toBe(
      'branch-scoped hook mount: unavailable (host dispatch carries no branchId)'
    );
    expect(diagnosis?.dispatches).toBe(3);
    expect(diagnosis?.branchProofApplied).toBe(0);
    expect(diagnosis?.summary).toContain('dispatches=3');
  });

  it('stays silent when a branch-class mount proved a branchId', () => {
    expect(
      diagnoseBranchScopedHookMount({
        hostAdapterSource: 'dsh-hooks',
        stats: statsOf({ applied: 2, branchProofApplied: 1 })
      })
    ).toBeUndefined();
  });

  it('stays silent before any dispatch was observed', () => {
    expect(
      diagnoseBranchScopedHookMount({
        hostAdapterSource: 'dsh-hooks',
        stats: statsOf({})
      })
    ).toBeUndefined();
    expect(
      diagnoseBranchScopedHookMount({ hostAdapterSource: 'dsh-hooks' })
    ).toBeUndefined();
  });

  it('never claims the DSH constraint for a non-hook adapter', () => {
    for (const source of ['injected', 'context', 'in-memory'] as const) {
      expect(
        diagnoseBranchScopedHookMount({
          hostAdapterSource: source,
          stats: statsOf({ applied: 5, delegated: 5 })
        })
      ).toBeUndefined();
    }
  });

  it('counts branch proof across every hook event, not just assemble', () => {
    const base = statsOf({ applied: 1 });
    const withPreStepProof: DshHookAdapterStats = {
      ...base,
      scope: {
        ...base.scope,
        preStep: {
          applied: 1,
          delegated: 0,
          branchProofApplied: 1,
          sessionOnlySuppressed: 0,
          anonymousSuppressed: 0
        }
      }
    };
    expect(
      diagnoseBranchScopedHookMount({
        hostAdapterSource: 'dsh-hooks',
        stats: withPreStepProof
      })
    ).toBeUndefined();
  });
});