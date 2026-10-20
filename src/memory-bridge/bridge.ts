/**
 * IMemoryBridge implementation: the governed Universal MCP Memory bridge.
 *
 * Pipeline for every call:
 *   recall  -> auto-discovery binding -> driver recall -> post-recall negative
 *              firewall (scope filter, whenNotToApply veto, polarity split)
 *   commit  -> deterministic pre-write gate (CCG completeness + script syntax +
 *              namespace/scope rules) -> driver write (only if accepted)
 *   promote -> branch/session lesson re-stamped as global and written to the
 *              global namespace; the branch copy is pruned when supported
 *   isolate -> deterministic namespace handle with an idempotent release
 *
 * No host types leak: everything is driven by the injected McpClient list.
 */

import type { MemoryBridgeConfig } from '../config';
import type {
  CanonicalLesson,
  GovernanceViolation,
  IMemoryBridge,
  MemoryBindingKind,
  MemoryBridgeDescriptor,
  MemoryCommitOptions,
  MemoryCommitResult,
  MemoryDriverKind,
  MemoryIsolationHandle,
  MemoryPromoteOptions,
  MemoryPruneOptions,
  MemoryPruneResult,
  MemoryRecallQuery,
  MemoryRecallResult,
  MemoryScope,
  SuppressedLesson
} from '../types/contracts';
import { autoDiscoverMemoryDriver } from './auto-discovery';
import type { AutoDiscoveryResult } from './auto-discovery';
import { buildRecallFingerprint, applyPostRecallFirewall, validateLessonForWrite, withNamespaceMetadata } from './governance-polyfill';
import { deriveNamespace, visibleNamespaces } from './namespace';
import type { McpClient } from './spi';
import { errorMessage } from './spi';

/** Maximum lessons a single recall may request from a backend. */
export const MAX_RECALL_LIMIT = 50;

/** Dependencies of the bridge; all host interaction is injected. */
export interface MemoryBridgeDeps {
  readonly config: MemoryBridgeConfig;
  /** Mounted MCP clients (stdio/SSE/in-process). */
  readonly clients?: readonly McpClient[];
  /** Deferred client provider, used when clients are mounted after start-up. */
  readonly listClients?: () => Promise<readonly McpClient[]>;
  /** Injectable clock (tests use a deterministic one). */
  readonly now?: () => number;
}

/** The bridge plus diagnostic accessors used by orchestration and tests. */
export interface UniversalMemoryBridge extends IMemoryBridge {
  readonly initialized: boolean;
  readonly disposed: boolean;
  /** Namespaces with a live isolation handle. */
  activeNamespaces(): readonly string[];
  /** Last auto-discovery result, when initialize() has run. */
  discoveryResult(): AutoDiscoveryResult | null;
}

/** Create a governed Universal MCP Memory bridge. */
export function createMemoryBridge(deps: MemoryBridgeDeps): UniversalMemoryBridge {
  const config = deps.config;
  const now = deps.now ?? (() => Date.now());
  let discovery: AutoDiscoveryResult | null = null;
  let pending: Promise<MemoryBridgeDescriptor> | null = null;
  let descriptor: MemoryBridgeDescriptor = unboundDescriptor();
  let disposed = false;
  const handles = new Map<string, MemoryIsolationHandle>();
  const seenLessonIds = new Map<string, Set<string>>();

  const bridge: UniversalMemoryBridge = {
    get descriptor(): MemoryBridgeDescriptor {
      return descriptor;
    },
    get initialized(): boolean {
      return discovery !== null;
    },
    get disposed(): boolean {
      return disposed;
    },
    initialize,
    recall,
    commit,
    isolate,
    promote,
    prune,
    dispose,
    activeNamespaces(): readonly string[] {
      return [...handles.keys()].sort();
    },
    discoveryResult(): AutoDiscoveryResult | null {
      return discovery;
    }
  };
  return bridge;

  function unboundDescriptor(): MemoryBridgeDescriptor {
    return {
      driverKind: 'unbound',
      serverId: null,
      backendLabel: 'unbound (not initialized)',
      capabilities: {
        metadataFiltering: false,
        namespaces: false,
        negativePolarity: false,
        temporal: false,
        supportsPrune: false
      },
      boundAt: now(),
      diagnostics: ['auto-discovery has not run yet']
    };
  }

  async function initialize(): Promise<MemoryBridgeDescriptor> {
    if (disposed) {
      return descriptor;
    }
    if (discovery !== null) {
      return descriptor;
    }
    if (pending !== null) {
      return pending;
    }
    pending = (async (): Promise<MemoryBridgeDescriptor> => {
      const clients = deps.clients ?? (deps.listClients === undefined ? [] : await deps.listClients());
      const result = await autoDiscoverMemoryDriver({ config, clients, now });
      discovery = result;
      descriptor = result.descriptor;
      return descriptor;
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }

  async function recall(query: MemoryRecallQuery): Promise<MemoryRecallResult> {
    const at = now();
    if (disposed) {
      return emptyRecall(query, descriptor.driverKind, at, ['memory bridge is disposed'], true);
    }
    await initialize();
    const result = discovery;
    if (result === null || result.driver === null || result.context === null) {
      return emptyRecall(
        query,
        descriptor.driverKind,
        at,
        [...descriptor.diagnostics, 'no MCP memory driver is bound: recall degrades to empty memory'],
        true
      );
    }
    const namespace = deriveNamespace(query.scope, config.namespacePrefix);
    const namespaces = visibleNamespaces(query.scope, config.namespacePrefix);
    const fingerprint = buildRecallFingerprint(query);
    const limit = clampLimit(query.limit ?? config.recallLimit);
    let records: readonly { lesson: CanonicalLesson; namespace: string }[] = [];
    const diagnostics: string[] = [];
    let degraded = false;
    try {
      const output = await result.driver.recall(result.context, {
        query,
        namespace,
        namespaces,
        limit,
        fingerprint,
        now: at
      });
      records = output.records;
      degraded = output.degraded === true;
      diagnostics.push(...(output.diagnostics ?? []));
    } catch (error) {
      degraded = true;
      diagnostics.push('driver recall failed: ' + errorMessage(error));
    }
    const firewall = applyPostRecallFirewall({
      records,
      query,
      scope: query.scope,
      config,
      minConfidence: typeof query.minConfidence === 'number' ? query.minConfidence : 0
    });
    return {
      query,
      scope: query.scope,
      driverKind: descriptor.driverKind,
      lessons: firewall.lessons,
      positiveLessons: firewall.positiveLessons,
      negativeLessons: firewall.negativeLessons,
      suppressedLessons: firewall.suppressedLessons,
      confidence: firewall.confidence,
      degraded,
      diagnostics: [...descriptor.diagnostics, ...diagnostics, ...firewall.diagnostics],
      recalledAt: now()
    };
  }

  async function commit(lesson: CanonicalLesson, options: MemoryCommitOptions): Promise<MemoryCommitResult> {
    const at = now();
    const namespace = deriveNamespace(options.scope, config.namespacePrefix);
    const lessonId = lesson !== null && typeof lesson === 'object' ? String(lesson.id) : '';
    if (disposed) {
      return {
        accepted: false,
        persisted: false,
        lessonId,
        namespace,
        driverKind: descriptor.driverKind,
        violations: [blocker('unsupported_operation', 'memory bridge is disposed')],
        at
      };
    }
    // 1. Deterministic pre-write gate: no backend call happens before it passes.
    const gate = validateLessonForWrite({
      lesson,
      scope: options.scope,
      config,
      namespace,
      existingLessonIds: seenLessonIds.get(namespace)
    });
    if (!gate.accepted) {
      return {
        accepted: false,
        persisted: false,
        lessonId,
        namespace,
        driverKind: descriptor.driverKind,
        violations: gate.violations,
        at
      };
    }
    if (options.dryRun === true) {
      return {
        accepted: true,
        persisted: false,
        lessonId,
        namespace,
        driverKind: descriptor.driverKind,
        violations: gate.violations,
        at
      };
    }
    await initialize();
    const result = discovery;
    if (result === null || result.driver === null || result.context === null) {
      return {
        accepted: false,
        persisted: false,
        lessonId,
        namespace,
        driverKind: descriptor.driverKind,
        violations: [...gate.violations, blocker('unsupported_operation', 'no MCP memory driver is bound for commit')],
        at
      };
    }
    const scoped = withNamespaceMetadata(lesson, namespace);
    try {
      const output = await result.driver.commit(result.context, { lesson: scoped, namespace, now: at });
      if (!output.persisted) {
        return {
          accepted: false,
          persisted: false,
          lessonId,
          namespace,
          driverKind: descriptor.driverKind,
          violations: [...gate.violations, ...(output.violations ?? [])],
          ...(output.backendRef === undefined ? {} : { backendRef: output.backendRef }),
          at
        };
      }
      rememberLesson(namespace, lessonId);
      return {
        accepted: true,
        persisted: true,
        lessonId,
        namespace,
        driverKind: descriptor.driverKind,
        violations: gate.violations,
        ...(output.backendRef === undefined ? {} : { backendRef: output.backendRef }),
        at
      };
    } catch (error) {
      return {
        accepted: false,
        persisted: false,
        lessonId,
        namespace,
        driverKind: descriptor.driverKind,
        violations: [
          ...gate.violations,
          blocker('unsupported_operation', 'backend commit failed: ' + errorMessage(error))
        ],
        at
      };
    }
  }

  function isolate(scope: MemoryScope): Promise<MemoryIsolationHandle> {
    const namespace = deriveNamespace(scope, config.namespacePrefix);
    const state = { active: true };
    const handle: MemoryIsolationHandle = {
      scope,
      namespace,
      get active(): boolean {
        return state.active;
      },
      async release(): Promise<void> {
        if (!state.active) {
          return;
        }
        state.active = false;
        handles.delete(namespace);
      }
    };
    handles.set(namespace, handle);
    return Promise.resolve(handle);
  }

  async function promote(lesson: CanonicalLesson, options: MemoryPromoteOptions): Promise<MemoryCommitResult> {
    const from = options.from;
    const to: MemoryScope = options.to ?? { kind: 'global' };
    const fromNamespace = deriveNamespace(from, config.namespacePrefix);
    const targetNamespace = deriveNamespace(to, config.namespacePrefix);
    const at = now();
    const lessonId = lesson !== null && typeof lesson === 'object' ? String(lesson.id) : '';
    if (disposed) {
      return {
        accepted: false,
        persisted: false,
        lessonId,
        namespace: targetNamespace,
        driverKind: descriptor.driverKind,
        violations: [blocker('unsupported_operation', 'memory bridge is disposed')],
        at
      };
    }
    const promoted = promoteLesson(lesson, to, fromNamespace, targetNamespace);
    const gate = validateLessonForWrite({
      lesson: promoted,
      scope: to,
      config,
      namespace: targetNamespace,
      existingLessonIds: seenLessonIds.get(targetNamespace)
    });
    if (!gate.accepted) {
      return {
        accepted: false,
        persisted: false,
        lessonId,
        namespace: targetNamespace,
        driverKind: descriptor.driverKind,
        violations: gate.violations,
        at
      };
    }
    await initialize();
    const result = discovery;
    if (result === null || result.driver === null || result.context === null) {
      return {
        accepted: false,
        persisted: false,
        lessonId,
        namespace: targetNamespace,
        driverKind: descriptor.driverKind,
        violations: [...gate.violations, blocker('unsupported_operation', 'no MCP memory driver is bound for promote')],
        at
      };
    }
    const violations: GovernanceViolation[] = [...gate.violations];
    let backendRef: string | undefined;
    try {
      const output = await result.driver.commit(result.context, { lesson: promoted, namespace: targetNamespace, now: at });
      backendRef = output.backendRef;
      if (!output.persisted) {
        return {
          accepted: false,
          persisted: false,
          lessonId,
          namespace: targetNamespace,
          driverKind: descriptor.driverKind,
          violations: [...violations, ...(output.violations ?? [])],
          ...(backendRef === undefined ? {} : { backendRef }),
          at
        };
      }
      rememberLesson(targetNamespace, lessonId);
    } catch (error) {
      return {
        accepted: false,
        persisted: false,
        lessonId,
        namespace: targetNamespace,
        driverKind: descriptor.driverKind,
        violations: [...violations, blocker('unsupported_operation', 'backend promote failed: ' + errorMessage(error))],
        at
      };
    }
    // Remove the branch/session copy so the winning lesson exists only globally.
    if (from.kind !== 'global' && result.driver.capabilities.namespaces) {
      try {
        const pruned = await result.driver.prune(result.context, { namespace: fromNamespace, ids: [lessonId], now: at });
        if (!pruned.removedIds.includes(lessonId)) {
          violations.push(
            warning(
              'unsupported_operation',
              'source copy in ' + fromNamespace + ' could not be removed for ' + lessonId
            )
          );
        }
      } catch (error) {
        violations.push(
          warning('unsupported_operation', 'source prune failed for ' + lessonId + ': ' + errorMessage(error))
        );
      }
    }
    return {
      accepted: true,
      persisted: true,
      lessonId,
      namespace: targetNamespace,
      driverKind: descriptor.driverKind,
      violations,
      ...(backendRef === undefined ? {} : { backendRef }),
      at
    };
  }

  async function prune(options: MemoryPruneOptions): Promise<MemoryPruneResult> {
    const dryRun = options.dryRun === true;
    const namespace = deriveNamespace(options.scope, config.namespacePrefix);
    if (disposed) {
      return { scanned: 0, removedIds: [], dryRun };
    }
    await initialize();
    const result = discovery;
    if (result === null || result.driver === null || result.context === null) {
      return { scanned: 0, removedIds: [], dryRun };
    }
    const at = now();
    let lessons: readonly CanonicalLesson[] = [];
    try {
      const output = await result.driver.recall(result.context, {
        query: { scope: options.scope, text: '' },
        namespace,
        namespaces: [namespace],
        limit: MAX_RECALL_LIMIT,
        fingerprint: '',
        now: at
      });
      lessons = output.records.map((record) => record.lesson);
    } catch {
      return { scanned: 0, removedIds: [], dryRun };
    }
    const scanned = lessons.length;
    const idFilter = options.ids === undefined ? undefined : new Set(options.ids);
    const candidates = lessons
      .filter((lesson) => (idFilter === undefined ? true : idFilter.has(lesson.id)))
      .filter((lesson) => (options.polarity === undefined ? true : lesson.polarity === options.polarity))
      .filter((lesson) => {
        if (typeof options.olderThan !== 'number') {
          return true;
        }
        const created = typeof lesson.createdAt === 'number' ? lesson.createdAt : 0;
        return created < options.olderThan;
      })
      .sort((left, right) => {
        const leftCreated = typeof left.createdAt === 'number' ? left.createdAt : 0;
        const rightCreated = typeof right.createdAt === 'number' ? right.createdAt : 0;
        if (leftCreated !== rightCreated) {
          return leftCreated - rightCreated;
        }
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
    const maxItems = typeof options.maxItems === 'number' ? Math.max(0, Math.trunc(options.maxItems)) : candidates.length;
    const selected = candidates.slice(0, maxItems).map((lesson) => lesson.id);
    if (dryRun || selected.length === 0) {
      return { scanned, removedIds: selected, dryRun };
    }
    if (result.driver.binding.prune === undefined) {
      return { scanned, removedIds: [], dryRun: false };
    }
    try {
      const output = await result.driver.prune(result.context, { namespace, ids: selected, now: at });
      return { scanned, removedIds: output.removedIds, dryRun: false };
    } catch {
      return { scanned, removedIds: [], dryRun: false };
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) {
      return;
    }
    disposed = true;
    handles.clear();
    seenLessonIds.clear();
  }

  function rememberLesson(namespace: string, lessonId: string): void {
    if (lessonId.length === 0) {
      return;
    }
    const existing = seenLessonIds.get(namespace);
    if (existing === undefined) {
      seenLessonIds.set(namespace, new Set([lessonId]));
      return;
    }
    existing.add(lessonId);
  }

  function clampLimit(limit: number): number {
    if (!Number.isFinite(limit)) {
      return config.recallLimit;
    }
    return Math.max(1, Math.min(Math.trunc(limit), MAX_RECALL_LIMIT));
  }

  function emptyRecall(
    query: MemoryRecallQuery,
    driverKind: MemoryBindingKind,
    at: number,
    diagnostics: readonly string[],
    degraded: boolean
  ): MemoryRecallResult {
    const suppressed: readonly SuppressedLesson[] = [];
    return {
      query,
      scope: query.scope,
      driverKind,
      lessons: [],
      positiveLessons: [],
      negativeLessons: [],
      suppressedLessons: suppressed,
      confidence: 0,
      degraded,
      diagnostics,
      recalledAt: at
    };
  }
}

/**
 * Re-stamp a lesson for the promotion target scope. Provenance (branchId) moves
 * into metadata so the global copy carries no branch-private identity.
 */
export function promoteLesson(
  lesson: CanonicalLesson,
  to: MemoryScope,
  fromNamespace: string,
  targetNamespace: string
): CanonicalLesson {
  const visibility = to.kind === 'global' ? 'global' : to.kind === 'session' ? 'session' : 'branch_private';
  const rest: Record<string, unknown> = { ...lesson };
  delete rest.branchId;
  const promoted = { ...(rest as unknown as CanonicalLesson), visibility } as CanonicalLesson;
  return withNamespaceMetadata(promoted, targetNamespace, {
    promotedFrom: fromNamespace,
    ...(lesson.branchId === undefined ? {} : { promotedFromBranchId: lesson.branchId })
  });
}

function blocker(code: GovernanceViolation['code'], message: string): GovernanceViolation {
  return { code, message, severity: 'block' };
}

function warning(code: GovernanceViolation['code'], message: string): GovernanceViolation {
  return { code, message, severity: 'warn' };
}

/** Driver kind of a bridge descriptor (diagnostic helper for orchestration). */
export function bridgeDriverKind(bridge: IMemoryBridge): MemoryBindingKind {
  return bridge.descriptor.driverKind;
}

/** Bound driver kind or undefined when unbound. */
export function boundDriverKindOf(bridge: IMemoryBridge): MemoryDriverKind | undefined {
  const kind = bridge.descriptor.driverKind;
  return kind === 'unbound' ? undefined : kind;
}
