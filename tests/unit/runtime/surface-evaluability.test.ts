/**
 * rev6 audit A3 (B9): the eight-surface evaluability matrix.
 *
 * The matrix is the ONE place that decides which surfaces a probe can measure.
 * Its text column must re-use the renderer's `TEXT_PROBE_EVALUABLE` (not a
 * second array), and the patch predicate must be fail-closed: empty, disabled,
 * unknown and non-executable edits are never "evaluable".
 */
import { describe, expect, it } from 'vitest';

import { HARNESS_COMPONENT_KEYS, type EightSurfacePatch } from '../../../src/types/contracts';
import { TEXT_PROBE_EVALUABLE } from '../../../src/dsh-bridge/patch-prompt';
import {
  PATCH_EVALUABILITY_REASON_CODES,
  SURFACE_EVALUABILITY,
  TEXT_PROBE_SURFACES,
  assessPatchEvaluability,
  patchEditedSurfaceKeys,
  effectiveProbeSurfaces,
  evaluableSurfaceKeys,
  isHarnessComponentKey,
  isPatchEvaluable,
  surfaceEvaluabilityOf
} from '../../../src/runtime/surface-evaluability';

function patch(edits: EightSurfacePatch['edits']): EightSurfacePatch {
  return {
    id: 'patch-a3',
    sessionId: 'session-a3',
    branchId: 'branch-a3',
    origin: 'domain',
    purpose: 'explore',
    guidance: 'memory',
    label: 'a3',
    rationale: 'a3 matrix fixture',
    edits,
    createdAt: 0
  } as unknown as EightSurfacePatch;
}

const SCRIPTS_ONLY = {
  scripts: {
    kind: 'scripts' as const,
    scripts: [{ path: 'probe.sh', language: 'bash' as const, code: 'echo probe' }]
  }
};
const SUBAGENTS_ONLY = {
  subagents: {
    kind: 'subagents' as const,
    agents: [{ name: 'helper', description: 'helper agent' }]
  }
};
const PLUGINS_ONLY = {
  plugins: {
    kind: 'plugins' as const,
    middleware: [
      {
        name: 'trace',
        hook: 'before_tool' as const,
        language: 'typescript' as const,
        code: 'export default () => undefined'
      }
    ]
  }
};

describe('surface-evaluability: matrix shape', () => {
  it('covers all eight canonical surfaces exactly once, in canonical order', () => {
    expect(SURFACE_EVALUABILITY).toHaveLength(8);
    expect(SURFACE_EVALUABILITY.map((row) => row.surface)).toEqual([...HARNESS_COMPONENT_KEYS]);
    expect(new Set(SURFACE_EVALUABILITY.map((row) => row.surface)).size).toBe(8);
  });

  it('re-exports the renderer text-probe set instead of declaring a second one', () => {
    expect([...TEXT_PROBE_SURFACES]).toEqual([...TEXT_PROBE_EVALUABLE]);
    expect([...evaluableSurfaceKeys()]).toEqual([...TEXT_PROBE_EVALUABLE]);
    expect(evaluableSurfaceKeys()).toHaveLength(5);
  });

  it('marks scripts / subagents / plugins as non-evaluable in every probe mode and recommends them off', () => {
    for (const key of ['scripts', 'subagents', 'plugins'] as const) {
      const row = surfaceEvaluabilityOf(key);
      expect(row.textProbe).toBe('none');
      expect(row.agentLoop).toBe('none');
      expect(row.dshRecommendation).toBe('off');
      expect(evaluableSurfaceKeys('agent-loop')).not.toContain(key);
    }
  });

  it('distinguishes the agent-loop mode only by completeness, not by the surface set', () => {
    expect([...evaluableSurfaceKeys('agent-loop')]).toEqual([...TEXT_PROBE_EVALUABLE]);
    expect(surfaceEvaluabilityOf('tool_guidance').textProbe).toBe('partial');
    expect(surfaceEvaluabilityOf('tool_guidance').agentLoop).toBe('full');
  });
});

describe('surface-evaluability: effective proposer surfaces', () => {
  it('intersects enabledSurfaces with the five text-evaluable surfaces', () => {
    expect([...effectiveProbeSurfaces([...HARNESS_COMPONENT_KEYS])]).toEqual([
      'system_prompt',
      'guardrails',
      'memory',
      'tool_guidance',
      'skills'
    ]);
    expect([...effectiveProbeSurfaces(['guardrails', 'scripts', 'skills'])]).toEqual([
      'guardrails',
      'skills'
    ]);
  });

  it('returns an empty list for scripts/subagents/plugins only (the caller must skip)', () => {
    expect(effectiveProbeSurfaces(['scripts', 'subagents', 'plugins'])).toEqual([]);
  });
});

describe('surface-evaluability: patch verdicts', () => {
  it('is fail-closed for an empty patch, a no-op and unknown edit keys', () => {
    expect(isPatchEvaluable(patch({}))).toBe(false);
    expect(assessPatchEvaluability(patch({})).reasonCode).toBe(PATCH_EVALUABILITY_REASON_CODES.empty);
    const unknown = patch({ not_a_surface: { kind: 'system_prompt' } } as never);
    expect(isPatchEvaluable(unknown)).toBe(false);
    expect(assessPatchEvaluability(unknown).editedSurfaces).toEqual([]);
  });

  it('rejects each non-executable surface on its own', () => {
    expect(isPatchEvaluable(patch(SCRIPTS_ONLY))).toBe(false);
    expect(isPatchEvaluable(patch(SUBAGENTS_ONLY))).toBe(false);
    expect(isPatchEvaluable(patch(PLUGINS_ONLY))).toBe(false);
    expect(assessPatchEvaluability(patch(PLUGINS_ONLY)).reasonCode).toBe(
      PATCH_EVALUABILITY_REASON_CODES.notEvaluable
    );
  });

  it('accepts a patch with at least one evaluable edit and reports the rest', () => {
    const mixed = patch({
      system_prompt: { kind: 'system_prompt', mode: 'append', content: 'surface body' },
      ...SCRIPTS_ONLY
    } as EightSurfacePatch['edits']);
    const verdict = assessPatchEvaluability(mixed);
    expect(verdict.evaluable).toBe(true);
    expect(verdict.editedSurfaces).toEqual(['system_prompt', 'scripts']);
    expect(verdict.notEvaluableSurfaces).toEqual(['scripts']);
    expect(verdict.reasonCode).toBe(PATCH_EVALUABILITY_REASON_CODES.evaluable);
  });

  it('rejects an enabled surface whose payload renders nothing (A1/A3 content gate)', () => {
    const emptyPayloads: EightSurfacePatch['edits'][] = [
      { guardrails: { kind: 'guardrails', appendRules: [] } },
      { guardrails: { kind: 'guardrails', forbiddenActions: [], toolPreconditions: [] } },
      { memory: { kind: 'memory', scopedViewId: 'view-only' } },
      { memory: { kind: 'memory', workingNotes: [], recallTags: [] } },
      { tool_guidance: { kind: 'tool_guidance', descriptions: {} } },
      { skills: { kind: 'skills', skills: [] } }
    ];
    for (const edits of emptyPayloads) {
      const verdict = assessPatchEvaluability(patch(edits));
      expect(verdict.evaluable, JSON.stringify(edits)).toBe(false);
      expect(verdict.renderedSurfaces).toEqual([]);
      expect(verdict.reasonCode).toBe(PATCH_EVALUABILITY_REASON_CODES.notRenderable);
    }
  });

  it('counts only renderable edits as evaluable and reports the empty sibling', () => {
    const mixed = patch({
      system_prompt: { kind: 'system_prompt', mode: 'append', content: 'surface body' },
      guardrails: { kind: 'guardrails', appendRules: [] }
    } as EightSurfacePatch['edits']);
    const verdict = assessPatchEvaluability(mixed);
    expect(verdict.evaluable).toBe(true);
    expect(verdict.renderedSurfaces).toEqual(['system_prompt']);
    expect(verdict.notEvaluableSurfaces).toEqual(['guardrails']);
  });

  it('honours the effective surface set (a disabled evaluable surface is not evaluable here)', () => {
    const guardrails = patch({
      guardrails: { kind: 'guardrails', appendRules: ['rule'] }
    });
    expect(isPatchEvaluable(guardrails)).toBe(true);
    expect(isPatchEvaluable(guardrails, { surfaces: ['system_prompt'] })).toBe(false);
    expect(
      assessPatchEvaluability(guardrails, { surfaces: ['system_prompt'] }).notEvaluableSurfaces
    ).toEqual(['guardrails']);
  });

  it('orders edited keys canonically and ignores non-surface keys', () => {
    expect(
      patchEditedSurfaceKeys(
        patch({
          skills: { kind: 'skills', skills: [] },
          system_prompt: { kind: 'system_prompt', mode: 'append', content: 'x' },
          metadata: { ignored: true }
        } as never) as EightSurfacePatch
      )
    ).toEqual(['system_prompt', 'skills']);
  });

  it('narrows surface keys structurally', () => {
    expect(isHarnessComponentKey('guardrails')).toBe(true);
    expect(isHarnessComponentKey('not_a_surface')).toBe(false);
    expect(isHarnessComponentKey(undefined)).toBe(false);
  });
});