/**
 * P4 status — the memory write-capability handshake and the forward-recall
 * observation, delivered as PURE module functions (C-7 delivery shape).
 *
 * Why pure: a handshake that probes a live backend could persist, enqueue or
 * warm-cache something on the far side, which is exactly what "no side effects"
 * forbids. The three-state writable verdict is therefore derived ONLY from data
 * a caller already holds — the bridge descriptor, the tools/list descriptors,
 * the resolved driver binding and the resolved execution profile — and never by
 * calling a tool. The Recall-Only / Read-Write label is what the plugin handle
 * renders; the entrypoint aggregation is wired by the integrator (t23), so this
 * module imports no host type and performs no I/O.
 *
 * Fail-closed resolution (A-t11-1 / A-t11-3):
 *   - 'no'      positive evidence the write path is closed: the bridge is
 *               unbound, the resolved memory permission is denied, the bound
 *               commit tool is not advertised, or tools/list advertises no
 *               commit-capable tool for the bound family;
 *   - 'unknown' the evidence is incomplete: no descriptor, no resolved
 *               permission, no tools/list, a custom-mapped family without its
 *               configured binding, or a commit tool whose schema declares no
 *               top-level input property. `unknown` is NOT `yes`;
 *   - 'yes'     permission allowed AND the commit tool advertised AND its input
 *               schema declares at least one top-level property.
 * Every non-'yes' state renders `Recall-Only` (unknown and no stay distinct in
 * the `writable` field and in the reason).
 *
 * Forward recall (A-t11-4 / A-t11-5): `matchLessonConditions` (in
 * ./governance-polyfill) applies the ONE CJK/latin clause rule to both the
 * positive channel (whenToApply) and the veto channel (whenNotToApply).
 * `observeRecallInShadow` is the record-only observation: it reports the
 * positive hit rate next to the firewall hit rate and what the LIVE firewall
 * keeps, while retaining every recalled lesson — shadow never filters, so the
 * default recall path is untouched.
 */

import type { MemoryBridgeConfig } from '../config';
import type {
  CanonicalLesson,
  MemoryBridgeDescriptor,
  MemoryRecallQuery,
  MemoryScope
} from '../types/contracts';
import { firstAvailable, fingerprintFor } from './drivers/index';
import { applyPostRecallFirewall, matchLessonConditions } from './governance-polyfill';
import type { DriverLessonRecord, McpToolDescriptor, MemoryDriverToolBinding } from './spi';
import { toolSchemaPropertyNames } from './spi';

// ---------------------------------------------------------------------------
// Writable handshake (A-t11-1 / A-t11-2 / A-t11-3)
// ---------------------------------------------------------------------------

/** Three-state write capability: never defaulted to 'yes'. */
export const MEMORY_WRITABLE_STATES = ['yes', 'no', 'unknown'] as const;
export type MemoryWritableState = (typeof MEMORY_WRITABLE_STATES)[number];

/** Access mode rendered by the plugin handle. */
export type MemoryAccessMode = 'recall-only' | 'read-write';

/** Render label for the access mode. */
export type MemoryStatusLabel = 'Recall-Only' | 'Read-Write';

export const RECALL_ONLY_LABEL: MemoryStatusLabel = 'Recall-Only';
export const READ_WRITE_LABEL: MemoryStatusLabel = 'Read-Write';

/** One resolved permission layer (structurally ExecutionProfile.permissions.memory). */
export interface MemoryWritePermissionView {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Structural view of the resolved execution profile: the caller may pass the
 * real ExecutionProfile object, a `{ permissions: { memory } }` slice, or a
 * bare permission.
 */
export interface MemoryExecutionProfileView {
  readonly mode?: string;
  readonly permissions?: {
    readonly memory?: MemoryWritePermissionView;
  };
}

/** Structural view of auto-discovery output (AutoDiscoveryResult). */
export interface MemoryDiscoveryView {
  readonly descriptor?: MemoryBridgeDescriptor | null;
  readonly tools?: readonly McpToolDescriptor[] | null;
  readonly selection?: {
    readonly candidate?: {
      readonly binding?: MemoryDriverToolBinding;
    } | null;
  } | null;
}

/** Input of the handshake: data only, no client, no callback. */
export interface MemoryBridgeStatusInput {
  readonly descriptor?: MemoryBridgeDescriptor | null;
  readonly discovery?: MemoryDiscoveryView | null;
  readonly tools?: readonly McpToolDescriptor[] | null;
  readonly binding?: MemoryDriverToolBinding | null;
  readonly profile?: MemoryExecutionProfileView | null;
  readonly permission?: MemoryWritePermissionView | null;
}

/** The status a plugin handle aggregates (incremental field, no option key). */
export interface MemoryBridgeStatus {
  readonly writable: MemoryWritableState;
  readonly mode: MemoryAccessMode;
  readonly label: MemoryStatusLabel;
  readonly reason: string;
  readonly diagnostics: readonly string[];
}

interface CommitEvidence {
  readonly toolName: string;
  readonly tool: McpToolDescriptor | undefined;
  readonly schemaProperties: readonly string[];
}

interface CommitResolution {
  readonly evidence: CommitEvidence | null;
  /** Positive evidence that the server advertises no write tool at all. */
  readonly advertisedNone: boolean;
  readonly reason: string;
}

function normalizeTools(value: readonly McpToolDescriptor[] | null | undefined): McpToolDescriptor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tools: McpToolDescriptor[] = [];
  for (const entry of value) {
    if (entry !== null && typeof entry === 'object' && typeof entry.name === 'string' && entry.name.length > 0) {
      tools.push(entry);
    }
  }
  return tools;
}

function evidenceFor(toolName: string, tool: McpToolDescriptor | undefined): CommitEvidence {
  return {
    toolName,
    tool,
    schemaProperties: tool === undefined ? [] : [...toolSchemaPropertyNames(tool)]
  };
}

/**
 * Resolve the commit tool from the data at hand: an explicit binding wins; a
 * bound canonical family falls back to its fingerprinted commit candidates;
 * the custom-mapped family cannot be resolved without its configured binding.
 */
function resolveCommitEvidence(
  descriptor: MemoryBridgeDescriptor | null,
  binding: MemoryDriverToolBinding | null,
  tools: readonly McpToolDescriptor[]
): CommitResolution {
  if (binding !== null) {
    const bound = tools.find((tool) => tool.name === binding.commit);
    if (bound !== undefined) {
      return {
        evidence: evidenceFor(bound.name, bound),
        advertisedNone: false,
        reason: 'the bound commit tool "' + bound.name + '" is advertised by tools/list'
      };
    }
    if (tools.length === 0) {
      return {
        evidence: evidenceFor(binding.commit, undefined),
        advertisedNone: false,
        reason: 'tools/list was not supplied, so the bound commit tool "' + binding.commit + '" cannot be confirmed'
      };
    }
    return {
      evidence: null,
      advertisedNone: true,
      reason: 'the bound commit tool "' + binding.commit + '" is not advertised by tools/list'
    };
  }
  if (descriptor !== null && descriptor.driverKind !== 'unbound') {
    if (descriptor.driverKind === 'custom_mapped') {
      return {
        evidence: null,
        advertisedNone: false,
        reason: 'the custom-mapped family needs its configured binding; none was supplied'
      };
    }
    if (tools.length === 0) {
      return { evidence: null, advertisedNone: false, reason: 'tools/list was not supplied' };
    }
    const available = new Set(tools.map((tool) => tool.name));
    const candidates = fingerprintFor(descriptor.driverKind)?.commitCandidates ?? [];
    const commitName = firstAvailable(available, candidates);
    if (commitName === undefined) {
      return {
        evidence: null,
        advertisedNone: true,
        reason: 'tools/list advertises no commit-capable tool for the bound ' + descriptor.driverKind + ' family'
      };
    }
    const tool = tools.find((entry) => entry.name === commitName);
    return {
      evidence: evidenceFor(commitName, tool),
      advertisedNone: false,
      reason: 'the commit-capable tool "' + commitName + '" is advertised by tools/list'
    };
  }
  return {
    evidence: null,
    advertisedNone: false,
    reason: 'no memory bridge descriptor or driver binding was supplied'
  };
}

function recallOnly(writable: Exclude<MemoryWritableState, 'yes'>, reason: string, diagnostics: string[]): MemoryBridgeStatus {
  return {
    writable,
    mode: 'recall-only',
    label: RECALL_ONLY_LABEL,
    reason,
    diagnostics
  };
}

/**
 * Resolve the writable three-state handshake and the rendered access mode.
 * Pure and synchronous: same input, same output, no tool call, no file I/O.
 */
export function resolveMemoryWritableStatus(input: MemoryBridgeStatusInput = {}): MemoryBridgeStatus {
  const descriptor = input.descriptor ?? input.discovery?.descriptor ?? null;
  const tools = normalizeTools(input.tools ?? input.discovery?.tools);
  const binding = input.binding ?? input.discovery?.selection?.candidate?.binding ?? null;
  const permission = input.permission ?? input.profile?.permissions?.memory ?? null;
  const profileMode = typeof input.profile?.mode === 'string' ? input.profile.mode : null;
  const diagnostics: string[] = [];

  if (descriptor === null) {
    diagnostics.push('no memory bridge descriptor was supplied');
  } else {
    diagnostics.push(
      'driver: ' + descriptor.driverKind + ' (server ' + (descriptor.serverId ?? 'none') + ')'
    );
    for (const entry of descriptor.diagnostics ?? []) {
      diagnostics.push('discovery: ' + entry);
    }
  }
  if (profileMode !== null) {
    diagnostics.push('execution mode: ' + profileMode);
  }
  if (permission === null) {
    diagnostics.push('memory write permission is not resolved');
  } else {
    diagnostics.push(
      'memory write permission: ' + (permission.allowed ? 'allowed' : 'denied') +
        (permission.reason === undefined ? '' : ' (' + permission.reason + ')')
    );
  }

  const commit = resolveCommitEvidence(descriptor, binding, tools);
  diagnostics.push(commit.reason);
  if (commit.evidence !== null) {
    diagnostics.push(
      'commit tool "' + commit.evidence.toolName + '" declares ' +
        commit.evidence.schemaProperties.length + ' top-level input property(ies)'
    );
  }
  diagnostics.push('tools/list descriptors inspected: ' + tools.length);

  // A denied permission is decisive on its own: no backend evidence can make a
  // write possible, so it outranks the "no descriptor yet" unknown state.
  if (permission !== null && permission.allowed === false) {
    return recallOnly(
      'no',
      'memory writes are denied: ' + (permission.reason ?? 'the resolved permission denies real memory writes'),
      diagnostics
    );
  }
  if (descriptor === null && binding === null) {
    return recallOnly('unknown', 'writability is unknown: the memory bridge has not published a descriptor or binding', diagnostics);
  }
  if (descriptor !== null && descriptor.driverKind === 'unbound') {
    return recallOnly('no', 'the memory backend is unbound: there is no driver to write through', diagnostics);
  }
  if (commit.advertisedNone) {
    return recallOnly('no', commit.reason, diagnostics);
  }
  if (commit.evidence === null) {
    return recallOnly('unknown', commit.reason + '; writability stays unknown', diagnostics);
  }
  if (permission === null) {
    return recallOnly(
      'unknown',
      'the memory write permission is not resolved, so writability cannot be confirmed',
      diagnostics
    );
  }
  if (commit.evidence.schemaProperties.length === 0) {
    return recallOnly(
      'unknown',
      'the commit tool "' + commit.evidence.toolName +
        '" declares no top-level input property, so a write payload cannot be confirmed',
      diagnostics
    );
  }
  return {
    writable: 'yes',
    mode: 'read-write',
    label: READ_WRITE_LABEL,
    reason:
      'memory writes are permitted and the ' + commit.evidence.toolName +
      ' commit tool advertises a ' + commit.evidence.schemaProperties.length + '-property write payload',
    diagnostics
  };
}

// ---------------------------------------------------------------------------
// Forward recall conditions + shadow (record-only) hit-rate observation
// ---------------------------------------------------------------------------

/** One recalled lesson's condition matches under the shared CJK/latin rule. */
export interface LessonConditionObservation {
  readonly lessonId: string;
  readonly polarity: string;
  /** whenToApply clauses matched by the query context (positive channel). */
  readonly matchedWhenToApply: readonly string[];
  /** whenNotToApply clauses matched by the query context (veto channel). */
  readonly matchedWhenNotToApply: readonly string[];
  /** True when the negative firewall would drop this lesson. */
  readonly vetoed: boolean;
}

/** Recalled lessons plus the positive/firewall hit rates (never filtered). */
export interface RecallConditionSummary {
  readonly recalled: number;
  /** Lessons with at least one matched whenToApply cue. */
  readonly triggerHits: number;
  /** Lessons with at least one matched whenNotToApply restraint. */
  readonly restraintHits: number;
  readonly triggerHitRate: number;
  readonly restraintHitRate: number;
  readonly observations: readonly LessonConditionObservation[];
}

function hitRate(hits: number, total: number): number {
  return total <= 0 ? 0 : hits / total;
}

/**
 * Observe both channels with the shared rule. Record-only: nothing is dropped,
 * so a caller can compare the positive hit rate with the firewall hit rate.
 */
export function summarizeRecallConditions(
  lessons: readonly CanonicalLesson[],
  query: MemoryRecallQuery
): RecallConditionSummary {
  const observations: LessonConditionObservation[] = [];
  let triggerHits = 0;
  let restraintHits = 0;
  for (const lesson of Array.isArray(lessons) ? lessons : []) {
    if (lesson === null || typeof lesson !== 'object' || typeof lesson.id !== 'string') {
      continue;
    }
    const matches = matchLessonConditions(lesson, query);
    const vetoed = matches.whenNotToApply.length > 0;
    if (matches.whenToApply.length > 0) {
      triggerHits += 1;
    }
    if (vetoed) {
      restraintHits += 1;
    }
    observations.push({
      lessonId: lesson.id,
      polarity: lesson.polarity,
      matchedWhenToApply: matches.whenToApply,
      matchedWhenNotToApply: matches.whenNotToApply,
      vetoed
    });
  }
  const recalled = observations.length;
  return {
    recalled,
    triggerHits,
    restraintHits,
    triggerHitRate: hitRate(triggerHits, recalled),
    restraintHitRate: hitRate(restraintHits, recalled),
    observations
  };
}

/** Input of the shadow observation: real recall records + the resolution data. */
export interface ShadowRecallInput {
  readonly records: readonly DriverLessonRecord[];
  readonly query: MemoryRecallQuery;
  readonly scope: MemoryScope;
  readonly config: MemoryBridgeConfig;
  readonly minConfidence?: number;
}

/** Record-only comparison between the positive channel and the live firewall. */
export interface ShadowRecallComparison extends RecallConditionSummary {
  readonly mode: 'shadow-record-only';
  /** Every recalled lesson, including the ones the live firewall would drop. */
  readonly retained: readonly CanonicalLesson[];
  /** Lessons the LIVE firewall keeps today (observation only, not applied). */
  readonly liveFirewallRetained: number;
  /** Lessons the LIVE firewall suppresses today (observation only). */
  readonly liveFirewallSuppressed: number;
  readonly diagnostics: readonly string[];
}

/**
 * Shadow/record-only recall observation (A-t11-5).
 *
 * The returned `retained` list is the UNFILTERED recall set: shadow mode records
 * what would be suppressed instead of suppressing it. To make the comparison
 * directly readable, the same input is also passed through the live
 * `applyPostRecallFirewall` — a pure function — and the retained/suppressed
 * counts are reported side by side with the positive and firewall hit rates.
 * The default recall path is untouched: this function has no side effect and
 * callers keep applying the firewall exactly as configured.
 */
export function observeRecallInShadow(input: ShadowRecallInput): ShadowRecallComparison {
  const records = Array.isArray(input.records) ? input.records : [];
  const lessons: CanonicalLesson[] = [];
  for (const record of records) {
    if (record !== null && typeof record === 'object' && record.lesson !== null && typeof record.lesson === 'object') {
      lessons.push(record.lesson);
    }
  }
  const summary = summarizeRecallConditions(lessons, input.query);
  const live = applyPostRecallFirewall({
    records,
    query: input.query,
    scope: input.scope,
    config: input.config,
    minConfidence: typeof input.minConfidence === 'number' ? input.minConfidence : 0
  });
  const diagnostics = [
    'shadow record-only: ' + summary.recalled + ' recalled, ' + summary.triggerHits +
      ' trigger hit(s) (' + formatRate(summary.triggerHitRate) + '), ' +
      summary.restraintHits + ' restraint hit(s) (' + formatRate(summary.restraintHitRate) + ')',
    'live firewall for the same input: ' + live.lessons.length + ' retained, ' +
      live.suppressedLessons.length + ' suppressed',
    ...live.diagnostics,
    'shadow mode records the firewall decision instead of applying it; the live recall path is unchanged'
  ];
  return {
    mode: 'shadow-record-only',
    ...summary,
    retained: lessons,
    liveFirewallRetained: live.lessons.length,
    liveFirewallSuppressed: live.suppressedLessons.length,
    diagnostics
  };
}

function formatRate(rate: number): string {
  return (Math.round(rate * 1000) / 10).toFixed(1) + '%';
}
