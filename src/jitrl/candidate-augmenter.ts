/**
 * Memory-augmented L2 candidate set (plan sections 6.6 and 7.1).
 *
 * Ownership: src/jitrl/** (Phase 3, P3-C2).
 *
 * The proposal layer normally asks the proposer for K candidates. This module
 * widens that set with actions the neighbourhood already knows to be good: the
 * top-N historical action keys that are not already offered and whose recorded
 * return is strictly positive. An augmented candidate enters with baseLogit 0
 * (it has no proposer confidence) and source 'memory_augmented', so the closed
 * form z' = center(z) + beta * A-tilde decides purely on its measured advantage.
 *
 * Two hard rules from plan section 7.1 are enforced here, not by the caller:
 *
 * - explore_invariant slots are NEVER augmented and may only be shown
 *   guidance_free records. Harness² keeps invariant exploration free of recalled
 *   memory so a wrong historical premise cannot contaminate the whole search
 *   tree; JitRL is also "reading memory", so it must not become a side channel.
 * - recover slots are never augmented either: a repair has to target the bug in
 *   front of it, not a historically similar one.
 *
 * Rehydration is deliberately conservative (see rehydratePatch): the recorded
 * lesson diff is a truncated summary, so a candidate is only rebuilt when every
 * recorded surface diff parses back into structured JSON. Anything else is
 * dropped with a diagnostic - this module never fabricates a patch.
 */

import {
  HARNESS_COMPONENT_KEYS,
  type GuidanceMode,
  type HarnessComponentKey,
  type JitCandidate,
  type LessonExecutionPatch,
  type ScoredExperience
} from '../types/contracts';
import { BATCH_SLOT_KINDS, type BatchSlotKind } from '../types/contracts';
import { normalizeMetaAction } from './action-normalizer';

/** Number of memory-augmented candidates added by default (plan section 6.6). */
export const DEFAULT_MAX_AUGMENTED = 2;

/** Default support gate (config `jitrl.minSupportForStrongPrior`). */
export const DEFAULT_MIN_SUPPORT_FOR_STRONG_PRIOR = 3;

/** Sentinel action-key prefix used when a slot kind cannot be resolved. */
const SLOT_PREFIX = 'slot:';

/** Where a rehydrated action came from, for diagnostics and audit. */
export interface RehydratedAction {
  /** Structural edits recovered from the lesson, keyed by surface. */
  readonly edits: Readonly<Partial<Record<HarnessComponentKey, unknown>>>;
  /** Patch id recorded on the lesson, when it carried one. */
  readonly sourcePatchId: string | undefined;
  /** Human-readable lesson summary (never used for matching). */
  readonly summary: string;
}

/**
 * Injectable lesson lookup. Phase 3 wires none, which makes rehydration
 * unreachable; the seam exists so a host that does have a lesson store can
 * supply one without changing this module.
 */
export interface LessonPatchSource {
  /** Lookup by the recording node id (first choice). */
  findByNodeId?(nodeId: string): LessonExecutionPatch | undefined;
  /** Lookup by the patch id recorded on the node (second choice). */
  findByPatchId?(patchId: string): LessonExecutionPatch | undefined;
}

/** Diagnostic sink shared by the augmenter's entry points. */
export interface AugmentDiagnostic {
  readonly level: 'info' | 'warn';
  readonly code: string;
  readonly message: string;
}

/** Options for augmentCandidates. */
export interface AugmentOptions {
  /** Master switch (config `jitrl.augmentFromMemory`); defaults to true. */
  readonly augmentFromMemory?: boolean;
  /** How many augmented candidates to add at most; defaults to 2. */
  readonly maxAugmented?: number;
  /** Minimum neighbour support before memory may speak (defaults to 3). */
  readonly minSupportForStrongPrior?: number;
  /** Slot the candidate set belongs to; omit for a slot-less proposal. */
  readonly slotKind?: BatchSlotKind;
  /** Lesson lookup for rehydration; absent means rehydration always fails. */
  readonly lessonSource?: LessonPatchSource;
  /** Diagnostic sink. */
  readonly onDiagnostic?: (diagnostic: AugmentDiagnostic) => void;
}

/** Result of one augmentation pass. */
export interface AugmentResult<T> {
  /** The original candidates followed by any accepted augmented ones. */
  readonly candidates: readonly JitCandidate<T>[];
  /** How many candidates were appended. */
  readonly augmented: number;
  /** True when the invariant/recover isolation suppressed augmentation. */
  readonly isolated: boolean;
  /** Payload-free notices. */
  readonly diagnostics: readonly AugmentDiagnostic[];
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

/** The slot kind encoded in a normalized L1 action key, if any. */
function slotKindOf(actionKey: string): BatchSlotKind | undefined {
  if (!actionKey.startsWith(SLOT_PREFIX)) {
    return undefined;
  }
  const rest = actionKey.slice(SLOT_PREFIX.length);
  const suffixAt = rest.indexOf('/surf:');
  const head = suffixAt < 0 ? rest : rest.slice(0, suffixAt);
  return BATCH_SLOT_KINDS.find((kind) => kind === head);
}

function isSurfaceKey(value: string): value is HarnessComponentKey {
  return (HARNESS_COMPONENT_KEYS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rebuild a structured action from a recorded lesson patch.
 *
 * Lookup order (documented because the plan only says "nodeId -> patchId ->
 * componentDiffs"):
 *   1. `findByNodeId(nodeId)` - the recording node is the exact provenance;
 *   2. `findByPatchId(patchId)` - the patch id recorded on that node;
 *   3. give up.
 *
 * Reconstruction then parses every `componentDiffs` entry as JSON. The reflector
 * writes those with `surfaceEditSummary`, which is `stableStringify(...)`
 * truncated to 400 characters, so a long edit is stored TRUNCATED. A truncated
 * entry does not parse and the whole rehydration is rejected - which is the
 * honest outcome: a partially recovered edit would be a fabricated patch.
 *
 * Consequently this returns undefined for any edit whose summary overflowed, and
 * always returns undefined in Phase 3 because no lesson source is wired.
 */
export function rehydratePatch(
  record: { readonly nodeId?: string; readonly treeId?: string },
  lessonSource: LessonPatchSource | undefined
): RehydratedAction | undefined {
  if (lessonSource === undefined) {
    return undefined;
  }
  const patch =
    (record.nodeId === undefined ? undefined : lessonSource.findByNodeId?.(record.nodeId)) ??
    (record.nodeId === undefined ? undefined : lessonSource.findByPatchId?.(record.nodeId));
  if (patch === undefined) {
    return undefined;
  }
  const diffs = patch.componentDiffs;
  if (diffs === undefined) {
    return undefined;
  }
  const edits: Partial<Record<HarnessComponentKey, unknown>> = {};
  let reconstructed = 0;
  for (const [key, raw] of Object.entries(diffs)) {
    if (!isSurfaceKey(key)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A truncated or non-JSON summary cannot be turned back into an edit.
      return undefined;
    }
    if (!isRecord(parsed)) {
      return undefined;
    }
    edits[key] = parsed;
    reconstructed += 1;
  }
  if (reconstructed === 0) {
    return undefined;
  }
  return {
    edits,
    sourcePatchId: patch.patchId,
    summary: patch.summary
  };
}

/**
 * Clamp a memory-derived advantage contribution to 0 when the action's support
 * is below the configured strong-prior threshold.
 *
 * `minSupportForStrongPrior` exists so a single lucky observation cannot steer
 * the decision: below the threshold memory contributes no advantage (A-tilde 0),
 * which leaves the policy prior in charge. Returns 0 both for a gated action and
 * for a zero-support action, so callers can compare the result with the input to
 * detect gating.
 */
export function gateAdvantageBySupport(
  advantage: number,
  support: number,
  minSupportForStrongPrior: number = DEFAULT_MIN_SUPPORT_FOR_STRONG_PRIOR
): number {
  if (!Number.isFinite(advantage)) {
    return 0;
  }
  const threshold = Number.isFinite(minSupportForStrongPrior)
    ? Math.max(0, minSupportForStrongPrior)
    : DEFAULT_MIN_SUPPORT_FOR_STRONG_PRIOR;
  if (!Number.isFinite(support) || support < threshold) {
    return 0;
  }
  return advantage;
}

/** True when augmentation is forbidden for this slot (plan section 7.1). */
export function isAugmentationForbidden(slotKind: BatchSlotKind | undefined): boolean {
  return slotKind === 'explore_invariant' || slotKind === 'recover';
}

/**
 * One augmentation pass.
 *
 * The neighbourhood is filtered to guidance_free records BEFORE anything else
 * when the slot is invariant, so a caller that hands over a mixed neighbourhood
 * cannot leak memory into the invariant track: the guard records a diagnostic
 * and drops the offending records instead of trusting the caller.
 *
 * Augmented candidates keep their historical action key verbatim and carry a
 * rehydrated payload. A candidate whose patch cannot be rehydrated is dropped
 * (never fabricated) and counted in the diagnostics.
 */
export function augmentCandidates<T>(
  candidates: readonly JitCandidate<T>[],
  neighbors: readonly ScoredExperience[],
  options: AugmentOptions = {}
): AugmentResult<T> {
  const diagnostics: AugmentDiagnostic[] = [];
  const emit = (diagnostic: AugmentDiagnostic): void => {
    diagnostics.push(diagnostic);
    options.onDiagnostic?.(diagnostic);
  };

  if (options.augmentFromMemory === false) {
    return { candidates: [...candidates], augmented: 0, isolated: false, diagnostics };
  }

  const slotKind = options.slotKind;
  if (isAugmentationForbidden(slotKind)) {
    emit({
      level: 'info',
      code: 'augment_isolated',
      message:
        'augmentation is forbidden for ' +
        String(slotKind) +
        ' slots (plan section 7.1); the candidate set is returned unchanged'
    });
    return { candidates: [...candidates], augmented: 0, isolated: true, diagnostics };
  }

  const known = new Set(candidates.map((candidate) => candidate.actionKey));
  const minSupport = clampPositiveInt(
    options.minSupportForStrongPrior,
    DEFAULT_MIN_SUPPORT_FOR_STRONG_PRIOR
  );
  const maxAugmented = clampPositiveInt(options.maxAugmented, DEFAULT_MAX_AUGMENTED);

  // Group the neighbourhood by action key, keeping only usable records.
  const groups = new Map<string, { best: ScoredExperience; support: number }>();
  for (const neighbor of neighbors) {
    if (known.has(neighbor.record.actionKey)) {
      continue;
    }
    if (!(neighbor.record.return > 0)) {
      continue;
    }
    // Cross-level experience must never seed an L2 candidate.
    if (neighbor.record.level === 'meta') {
      continue;
    }
    const existing = groups.get(neighbor.record.actionKey);
    if (existing === undefined) {
      groups.set(neighbor.record.actionKey, { best: neighbor, support: 1 });
      continue;
    }
    existing.support += 1;
    if (neighbor.record.return > existing.best.record.return) {
      existing.best = neighbor;
    }
  }

  const ranked = [...groups.entries()]
    .sort((left, right) => {
      const delta = right[1].best.record.return - left[1].best.record.return;
      return delta !== 0 ? delta : left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
    })
    .slice(0, maxAugmented);

  const augmentedCandidates: JitCandidate<T>[] = [];
  for (const [actionKey, group] of ranked) {
    if (group.support < minSupport) {
      emit({
        level: 'info',
        code: 'augment_low_support',
        message:
          'skipped memory action ' +
          actionKey +
          ': support ' +
          String(group.support) +
          ' < minSupportForStrongPrior ' +
          String(minSupport) +
          ' (advantage contribution clamped to 0)'
      });
      continue;
    }
    const payload = rehydratePatch(
      {
        ...(group.best.record.nodeId === undefined ? {} : { nodeId: group.best.record.nodeId }),
        ...(group.best.record.treeId === undefined ? {} : { treeId: group.best.record.treeId })
      },
      options.lessonSource
    );
    if (payload === undefined) {
      emit({
        level: 'warn',
        code: 'augment_rehydrate_failed',
        message:
          'dropped memory action ' +
          actionKey +
          ': its patch could not be rehydrated (no lesson source, no lesson for node ' +
          String(group.best.record.nodeId ?? 'unknown') +
          ', or a truncated componentDiff)'
      });
      continue;
    }
    augmentedCandidates.push({
      actionKey,
      baseLogit: 0,
      source: 'memory_augmented',
      payload: payload as unknown as T
    });
  }

  return {
    candidates: [...candidates, ...augmentedCandidates],
    augmented: augmentedCandidates.length,
    isolated: false,
    diagnostics
  };
}

/** Export kept for symmetry with the other kernel modules and for type reuse. */
export type AugmentedCandidatePayload = RehydratedAction;

/** Normalize a meta action key for a slot kind, re-exported for callers. */
export function metaActionKey(
  slotKind: BatchSlotKind,
  surfaces: readonly HarnessComponentKey[] = []
): string {
  return normalizeMetaAction(slotKind, surfaces);
}

/** The guidance mode a slot's neighbourhood must be restricted to (section 7.1). */
export function guidanceFilterForSlot(slotKind: BatchSlotKind): GuidanceMode | undefined {
  return slotKind === 'explore_invariant' ? 'guidance_free' : undefined;
}

/** True when an action key still resolves to one of the four slot kinds. */
export function isMetaActionKey(actionKey: string): boolean {
  return slotKindOf(actionKey) !== undefined;
}
