/**
 * Eight-surface evaluability matrix (rev6 audit A3/B9).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The proposer used to be allowed to spend a candidate rollout on any of the
 * eight surfaces. Three of them (`scripts`, `subagents`, `plugins`) cannot be
 * exercised by a text probe at all: a text probe never executes generated code,
 * never registers a subagent and never mounts middleware. A patch that touched
 * only those surfaces therefore produced a candidate probe whose prompt could
 * not differ from the reference (A1 explicitly renders a "not evaluable" line
 * instead of the payload), a reward contrast of zero, and - before A4-1 - an
 * unverified online experience record. That is pure budget waste, and it is
 * exactly the failure B9 documents.
 *
 * This module is the ONE place that answers "can this probe mode evaluate this
 * surface?" and "can this patch be evaluated at all?". The orchestrator uses it
 * to:
 *   1. restrict what the proposer is told it may edit
 *      (`effectiveProbeSurfaces`), and
 *   2. skip a proposal whose every edit lands on a non-evaluable (or disabled)
 *      surface (`assessPatchEvaluability`) BEFORE a tree node is created, a
 *      probe is launched or any experience is written.
 *
 * ONE SOURCE OF TRUTH
 * -------------------
 * `TEXT_PROBE_EVALUABLE` lives in `src/dsh-bridge/patch-prompt.ts`, the module
 * that actually renders the text-probe prompt. This file RE-EXPORTS it instead
 * of declaring a second array, so the matrix and the renderer can never drift.
 * The matrix adds the other probe modes and the DSH recommendation columns the
 * runbook reads; it does not redefine the text-probe set.
 *
 * FAIL-CLOSED
 * -----------
 * `isPatchEvaluable` requires at least one edited surface to be BOTH in the
 * evaluable set AND in the effective (enabled) set. An empty patch, an unknown
 * edit key, a disabled evaluable surface and a non-evaluable surface are all
 * `false`. "Not evaluable" is never treated as a failure: the orchestrator
 * records a diagnostic and keeps the reference probe; nothing is scored.
 */

import {
  HARNESS_COMPONENT_KEYS,
  type EightSurfacePatch,
  type HarnessComponentKey
} from '../types/contracts';
import { TEXT_PROBE_EVALUABLE, renderPatchEdits } from '../dsh-bridge/patch-prompt';

/**
 * The text-probe evaluable surfaces, re-exported from the module that renders
 * the prompt (never declared again here).
 */
export const TEXT_PROBE_SURFACES: readonly HarnessComponentKey[] = [...TEXT_PROBE_EVALUABLE];

/** The probe modes the matrix distinguishes. */
export type SurfaceProbeMode = 'text' | 'agent-loop';

/** How completely a probe mode can exercise one surface. */
export type SurfaceEvaluability = 'full' | 'partial' | 'none';

/**
 * What the live DSH hook layer can do with one surface (rc5 evidence):
 *   - `native-unscoped`: a native seam exists, but the host dispatch carries no
 *     branchId, so a BRANCH-SCOPED mount is fail-closed. Only a permanent mount
 *     under guarded-active is reachable.
 *   - `native-permanent-only`: the seam exists but is only used by the
 *     permanent winning-patch mount.
 *   - `not-run`: not exercised by the rc5 host smoke at all.
 */
export type HostHookAvailability = 'native-unscoped' | 'native-permanent-only' | 'not-run';

/** The DSH operating recommendation for a fresh deployment. */
export type DshSurfaceRecommendation =
  | 'on'
  | 'on-with-agent-loop'
  | 'on-working-notes-only'
  | 'off';

/** One row of the eight-surface matrix. */
export interface SurfaceEvaluabilityRow {
  readonly surface: HarnessComponentKey;
  /** Can a same-process TEXT probe exercise a behavioural difference? */
  readonly textProbe: SurfaceEvaluability;
  /** Can an agent-loop probe (read-only tool allowlist) exercise it? */
  readonly agentLoop: SurfaceEvaluability;
  /** What the DSH rc5 hook layer can do (evidence, not a promise). */
  readonly hostHook: HostHookAvailability;
  /** What a safe first run should enable. */
  readonly dshRecommendation: DshSurfaceRecommendation;
  /** Why the row says what it says. */
  readonly rationale: string;
}

/**
 * The matrix, in the canonical `HARNESS_COMPONENT_KEYS` order. Every one of the
 * eight keys appears exactly once (pinned by the unit test).
 *
 * The `agentLoop` column is deliberately still `none` for scripts/subagents/
 * plugins: the executor in this repository does not run generated code, and
 * A4-5 does NOT add a worktree/read-only-tool runner. `tool_guidance` is the
 * only surface that goes from `partial` (text sees the description) to `full`
 * (the agent loop actually invokes the tool).
 */
export const SURFACE_EVALUABILITY: readonly SurfaceEvaluabilityRow[] = Object.freeze([
  {
    surface: 'system_prompt',
    textProbe: 'full',
    agentLoop: 'full',
    hostHook: 'native-unscoped',
    dshRecommendation: 'on',
    rationale:
      'patch-prompt renders append/replace content in the candidate probe; the hook seam is native but has no branchId on rc5'
  },
  {
    surface: 'guardrails',
    textProbe: 'partial',
    agentLoop: 'partial',
    hostHook: 'native-unscoped',
    dshRecommendation: 'on',
    rationale:
      'output contract, append rules, forbidden actions and tool preconditions are visible; only explicit tool:/deny: rules can be host-enforced, natural-language rules stay advisory'
  },
  {
    surface: 'memory',
    textProbe: 'partial',
    agentLoop: 'partial',
    hostHook: 'not-run',
    dshRecommendation: 'on-working-notes-only',
    rationale:
      'branch-scoped working notes and recall tags are visible; no real recall or memory write runs inside a probe'
  },
  {
    surface: 'tool_guidance',
    textProbe: 'partial',
    agentLoop: 'full',
    hostHook: 'not-run',
    dshRecommendation: 'on-with-agent-loop',
    rationale:
      'a text probe only reads descriptions/priority/examples; only an agent-loop probe with a tool runtime actually invokes them'
  },
  {
    surface: 'skills',
    textProbe: 'full',
    agentLoop: 'full',
    hostHook: 'not-run',
    dshRecommendation: 'on',
    rationale: 'each skill markdown is rendered as its own section and needs no execution'
  },
  {
    surface: 'scripts',
    textProbe: 'none',
    agentLoop: 'none',
    hostHook: 'not-run',
    dshRecommendation: 'off',
    rationale:
      'generated code is never executed by any probe in this repository; a text probe must not pretend it ran'
  },
  {
    surface: 'subagents',
    textProbe: 'none',
    agentLoop: 'none',
    hostHook: 'not-run',
    dshRecommendation: 'off',
    rationale: 'dynamic subagent registration is not exercised by a probe'
  },
  {
    surface: 'plugins',
    textProbe: 'none',
    agentLoop: 'none',
    hostHook: 'native-permanent-only',
    dshRecommendation: 'off',
    rationale:
      'middleware is only ever mounted permanently under guarded-active; no branch-scoped dispatch exists on rc5'
  }
]);

const ROW_BY_SURFACE = new Map<HarnessComponentKey, SurfaceEvaluabilityRow>(
  SURFACE_EVALUABILITY.map((row) => [row.surface, row] as const)
);

/** The canonical eight keys, re-exported for matrix consumers. */
export { HARNESS_COMPONENT_KEYS as SURFACE_KEYS };

/** True for a string that is one of the eight frozen surface keys. */
export function isHarnessComponentKey(value: unknown): value is HarnessComponentKey {
  return typeof value === 'string' && (HARNESS_COMPONENT_KEYS as readonly string[]).includes(value);
}

/** The matrix row for one surface; total over the eight keys. */
export function surfaceEvaluabilityOf(surface: HarnessComponentKey): SurfaceEvaluabilityRow {
  const row = ROW_BY_SURFACE.get(surface);
  if (row === undefined) {
    // Structurally unreachable: SURFACE_EVALUABILITY covers every key. Returning
    // a fail-closed row instead of throwing keeps a host-supplied value from
    // crashing a diagnostic path.
    return {
      surface,
      textProbe: 'none',
      agentLoop: 'none',
      hostHook: 'not-run',
      dshRecommendation: 'off',
      rationale: 'unknown surface: treated as not evaluable'
    };
  }
  return row;
}

/**
 * The surfaces one probe mode can evaluate, in canonical order.
 *
 * `text` is the default and is EXACTLY `TEXT_PROBE_EVALUABLE` (5 keys). The
 * agent-loop mode also excludes the same three non-executable surfaces, so it
 * is 5 keys too - but tool_guidance is `full` rather than `partial`.
 */
export function evaluableSurfaceKeys(mode: SurfaceProbeMode = 'text'): readonly HarnessComponentKey[] {
  return SURFACE_EVALUABILITY.filter((row) =>
    mode === 'agent-loop' ? row.agentLoop !== 'none' : row.textProbe !== 'none'
  ).map((row) => row.surface);
}

/**
 * The EFFECTIVE surface set for a run: `config.enabledSurfaces` intersected
 * with the text-probe evaluable set, in canonical order.
 *
 * This is the exact list handed to the proposer's `allowedSurfaces`. Passing
 * `config.enabledSurfaces` unchanged would let the proposer spend a rollout on
 * scripts/subagents/plugins; passing an empty list would make the Harness²
 * proposer fall back to ALL eight (`allowedSurfacesFor`), which is the opposite
 * of a restriction. A caller must therefore treat `[]` as "no candidate can be
 * evaluated" and skip the run - the orchestrator does exactly that.
 */
export function effectiveProbeSurfaces(
  enabledSurfaces: readonly HarnessComponentKey[],
  mode: SurfaceProbeMode = 'text'
): readonly HarnessComponentKey[] {
  const enabled = new Set<HarnessComponentKey>(enabledSurfaces);
  return evaluableSurfaceKeys(mode).filter((surface) => enabled.has(surface));
}

/** Options for {@link assessPatchEvaluability}. */
export interface PatchEvaluabilityOptions {
  /** Probe mode whose evaluable set applies; defaults to `text`. */
  readonly mode?: SurfaceProbeMode;
  /**
   * The effective surface set for this run (normally
   * `effectiveProbeSurfaces(config.enabledSurfaces)`). When omitted, the
   * mode's full evaluable set is used.
   */
  readonly surfaces?: readonly HarnessComponentKey[];
}

/** The evaluability verdict for one patch, with the facts behind it. */
export interface PatchEvaluability {
  /** True iff at least one edited surface is renderable AND in `surfaces`. */
  readonly evaluable: boolean;
  /** Edited surfaces, in canonical order (unknown keys are ignored). */
  readonly editedSurfaces: readonly HarnessComponentKey[];
  /**
   * Edited surfaces whose payload actually renders probe content. A key can be
   * present with an empty payload (`guardrails: { appendRules: [] }`); that is
   * edited but NOT renderable, so it can never justify a candidate probe.
   */
  readonly renderedSurfaces: readonly HarnessComponentKey[];
  /** The effective set this verdict was computed against. */
  readonly surfaces: readonly HarnessComponentKey[];
  /** Edited surfaces that are NOT renderable and/or NOT in the effective set. */
  readonly notEvaluableSurfaces: readonly HarnessComponentKey[];
  /**
   * Stable numeric code for the whole patch verdict: 0 = evaluable. Non-zero
   * values are diagnostic only and are not persisted on any record.
   */
  readonly reasonCode: 0 | 1 | 2 | 3;
}

/** Reason codes for {@link assessPatchEvaluability}. Append-only. */
export const PATCH_EVALUABILITY_REASON_CODES = Object.freeze({
  /** At least one edit is on an effective, evaluable, renderable surface. */
  evaluable: 0,
  /** The patch edits nothing (a no-op cannot be measured). */
  empty: 1,
  /** Every edit is on a surface this probe cannot evaluate / is not enabled. */
  notEvaluable: 2,
  /**
   * Every edit is on an enabled surface but renders NOTHING (empty arrays,
   * `memory.scopedViewId` alone, absent bodies). This is the A1/A3 gap: key
   * presence alone used to admit a rationale-only probe.
   */
  notRenderable: 3
});

/** The canonically ordered edit keys of one patch. */
export function patchEditedSurfaceKeys(
  patch: Pick<EightSurfacePatch, 'edits'>
): readonly HarnessComponentKey[] {
  const edits: unknown = patch.edits;
  if (edits === null || typeof edits !== 'object' || Array.isArray(edits)) {
    return [];
  }
  const present = new Set(Object.keys(edits as Record<string, unknown>).filter(isHarnessComponentKey));
  return HARNESS_COMPONENT_KEYS.filter((key) => present.has(key));
}

/**
 * Decide whether a patch can be evaluated by the given probe mode.
 *
 * The decision is CONTENT-level, not key-level: it reuses the exact renderer
 * that builds the probe prompt (`renderPatchEdits`). A patch whose keys are all
 * enabled but whose payloads render nothing (`guardrails: { appendRules: [] }`,
 * `memory: { scopedViewId: 'x' }`) is NOT evaluable - otherwise a candidate
 * probe would spend budget on a prompt indistinguishable from the reference.
 *
 * Total and non-throwing: a malformed `edits` bag is treated as empty (reason
 * `empty`), and unknown surface keys never count as evaluable.
 */
export function assessPatchEvaluability(
  patch: Pick<EightSurfacePatch, 'edits'>,
  options: PatchEvaluabilityOptions = {}
): PatchEvaluability {
  const mode = options.mode ?? 'text';
  const surfaces = options.surfaces ?? evaluableSurfaceKeys(mode);
  const allowed = new Set<HarnessComponentKey>(surfaces);
  const editedSurfaces = patchEditedSurfaceKeys(patch);
  if (editedSurfaces.length === 0) {
    return {
      evaluable: false,
      editedSurfaces,
      renderedSurfaces: [],
      surfaces: [...surfaces],
      notEvaluableSurfaces: [],
      reasonCode: PATCH_EVALUABILITY_REASON_CODES.empty
    };
  }
  const rendered = renderPatchEdits(patch.edits);
  const renderable = new Set<HarnessComponentKey>(rendered.renderedSurfaces);
  // A surface counts only when it is BOTH enabled for this run AND has content
  // the renderer would put into the probe. Non-evaluable surfaces are never
  // renderable by construction, so the renderable set is the stricter gate.
  const evaluableSurfaces = editedSurfaces.filter(
    (surface) => allowed.has(surface) && renderable.has(surface)
  );
  const notEvaluableSurfaces = editedSurfaces.filter(
    (surface) => !allowed.has(surface) || !renderable.has(surface)
  );
  // Priority matters for the diagnostic: an all-disabled/non-evaluable patch is
  // `notEvaluable` (2), while a patch that DID touch an enabled surface but
  // rendered nothing is `notRenderable` (3). Only the latter is the A1/A3 gap.
  const touchesEnabledSurface = editedSurfaces.some((surface) => allowed.has(surface));
  const reasonCode =
    evaluableSurfaces.length > 0
      ? PATCH_EVALUABILITY_REASON_CODES.evaluable
      : touchesEnabledSurface
        ? PATCH_EVALUABILITY_REASON_CODES.notRenderable
        : PATCH_EVALUABILITY_REASON_CODES.notEvaluable;
  return {
    evaluable: evaluableSurfaces.length > 0,
    editedSurfaces,
    renderedSurfaces: [...renderable],
    surfaces: [...surfaces],
    notEvaluableSurfaces,
    reasonCode
  };
}

/** Convenience predicate over {@link assessPatchEvaluability}. */
export function isPatchEvaluable(
  patch: Pick<EightSurfacePatch, 'edits'>,
  options: PatchEvaluabilityOptions = {}
): boolean {
  return assessPatchEvaluability(patch, options).evaluable;
}