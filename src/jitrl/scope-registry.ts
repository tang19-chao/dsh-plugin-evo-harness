/**
 * Scope registry for JitRL branch and experience scope isolation (plan section 5.2; PR3/R2+R3).
 *
 * Scopes are registered from trusted internal sources (branch creation/mounting
 * inside seam-manager or orchestrator). Untrusted payloads self-claiming
 * 'invariant' or 'domain' are NEVER trusted.
 *
 * resolve(...payloads) extracts the identity (sessionId, branchId) and resolves
 * against registered scopes. If not registered or identity cannot be proven,
 * it returns 'unknown'.
 *
 * Invariant branches registered here enforce allowAdvice: false and
 * guidance: 'guidance_free' by construction, sealing the advice channel.
 */

import type { GuidanceMode } from '../types/contracts';

export type ScopeRole = 'domain' | 'invariant' | 'general' | 'reference' | 'candidate';

/** Input specification for registering a trusted scope. */
export interface ScopeRegistrationSpec {
  readonly sessionId: string;
  readonly branchId: string;
  readonly namespace?: string;
  readonly role?: ScopeRole;
  /** Provenance/origin of the slot (e.g. 'explore_invariant'). Invariant origins force invariant role. */
  readonly origin?: string;
  /** Guidance mode: 'memory' for domain/general, 'guidance_free' for invariant. Defaults based on role. */
  readonly guidance?: GuidanceMode;
  /** Whether L3 host advisor may inject advice into this branch. Invariant branches force false. */
  readonly allowAdvice?: boolean;
  /** Custom metadata (trusted). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** TTL in milliseconds for this registration. */
  readonly ttlMs?: number;
}

/** An immutable registered scope record. */
export interface RegisteredScope {
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly namespace?: string;
  readonly role: ScopeRole;
  readonly origin?: string;
  readonly guidance: GuidanceMode;
  readonly allowAdvice: boolean;
  readonly isInvariant: boolean;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Disposer handle returned by ScopeRegistry.register(). */
export interface ScopeRegistrationHandle {
  readonly scope: RegisteredScope;
  dispose(): void;
  unregister(): void;
}

/** Options for createScopeRegistry(). */
export interface ScopeRegistryOptions {
  /** Maximum registered scopes retained concurrently (LRU eviction). Default 256. */
  readonly maxScopes?: number;
  /** Default TTL in milliseconds for registered scopes. Default 30 min (1_800_000 ms). */
  readonly ttlMs?: number;
  /** Injected clock. */
  readonly now?: () => number;
  /** Diagnostic sink (payload-free). */
  readonly onDiagnostic?: (message: string) => void;
}

/** Core ScopeRegistry interface. */
export interface ScopeRegistry {
  register(spec: ScopeRegistrationSpec): ScopeRegistrationHandle;
  unregister(scopeKeyOrBranchId: string): boolean;
  resolve(...payloads: readonly unknown[]): RegisteredScope | 'unknown';
  get(scopeKeyOrBranchId: string): RegisteredScope | undefined;
  has(scopeKeyOrBranchId: string): boolean;
  activeScopes(): readonly RegisteredScope[];
  prune(now?: number): number;
  size(): number;
  clear(): void;
  dispose(): void;
  readonly isDisposed: boolean;
}

export function formatScopeKey(sessionId: string, branchId: string): string {
  const s = typeof sessionId === 'string' ? sessionId.trim() : '';
  const b = typeof branchId === 'string' ? branchId.trim() : '';
  return `${s}::${b}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

const CARRIER_KEYS = ['agent', 'session', 'scope', 'context', 'parent', 'branch'] as const;

/** Extract branch and session identities from arbitrary payloads, matching hook scope rules. */
export function extractScopeIdentity(...payloads: readonly unknown[]): {
  readonly branchIds: ReadonlySet<string>;
  readonly sessionIds: ReadonlySet<string>;
} {
  const branchIds = new Set<string>();
  const sessionIds = new Set<string>();

  const addStr = (target: Set<string>, val: unknown): void => {
    if (typeof val === 'string' && val.trim().length > 0) {
      target.add(val.trim());
    }
  };

  const visit = (value: unknown, depth: number, readId: boolean): void => {
    const record = asRecord(value);
    if (record === undefined || depth > 4) {
      return;
    }
    if (readId) {
      const id = record['id'];
      if (typeof id === 'string' && id.trim().length > 0) {
        sessionIds.add(id.trim());
      }
    }
    addStr(branchIds, record['branchId']);
    addStr(sessionIds, record['sessionId']);
    addStr(branchIds, record['branch']);
    addStr(sessionIds, record['session']);
    addStr(branchIds, record['branchName']);

    for (const key of CARRIER_KEYS) {
      const child = record[key];
      if (child !== undefined) {
        visit(child, depth + 1, key === 'agent' || key === 'session' || key === 'branch');
      }
    }
  };

  for (const payload of payloads) {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        visit(item, 0, false);
      }
    } else {
      visit(payload, 0, false);
    }
  }

  return { branchIds, sessionIds };
}

/**
 * Conservative heuristic guardrails for invariant branch detection.
 * Slot invariance is primarily determined by trusted registration provenance
 * (role: 'invariant', guidance: 'guidance_free', origin: 'explore_invariant').
 * Name heuristics serve only as extra defense-in-depth guards.
 */
export function isInvariantScopeName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith('inv-') ||
    lower.includes('invariant') ||
    lower.includes('guidance_free')
  );
}

/** Create a trusted ScopeRegistry instance. */
export function createScopeRegistry(options: ScopeRegistryOptions = {}): ScopeRegistry {
  const maxScopes = typeof options.maxScopes === 'number' && options.maxScopes > 0 ? options.maxScopes : 256;
  const defaultTtlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : 1_800_000;
  const now = options.now ?? ((): number => Date.now());

  let disposed = false;
  // Map from scopeKey (sessionId::branchId) to RegisteredScope
  const scopesByCompound = new Map<string, RegisteredScope>();
  // Map from branchId to set of compoundKeys for multi-session isolation (PR3 / F6)
  const branchToCompounds = new Map<string, Set<string>>();
  // Insertion order tracking for LRU eviction
  const order: string[] = [];

  const note = (msg: string): void => {
    options.onDiagnostic?.(msg);
  };

  const isExpired = (scope: RegisteredScope, currentNow: number): boolean => {
    return scope.expiresAt !== undefined && scope.expiresAt <= currentNow;
  };

  const addBranchMapping = (branchId: string, compoundKey: string): void => {
    let set = branchToCompounds.get(branchId);
    if (set === undefined) {
      set = new Set<string>();
      branchToCompounds.set(branchId, set);
    }
    set.add(compoundKey);
  };

  const removeBranchMapping = (branchId: string, compoundKey: string): void => {
    const set = branchToCompounds.get(branchId);
    if (set !== undefined) {
      set.delete(compoundKey);
      if (set.size === 0) {
        branchToCompounds.delete(branchId);
      }
    }
  };

  const removeInternal = (compoundKey: string): boolean => {
    const existing = scopesByCompound.get(compoundKey);
    if (existing === undefined) {
      return false;
    }
    scopesByCompound.delete(compoundKey);
    removeBranchMapping(existing.branchId, compoundKey);
    const idx = order.indexOf(compoundKey);
    if (idx >= 0) {
      order.splice(idx, 1);
    }
    return true;
  };

  const evictOldestIfNeeded = (): void => {
    while (scopesByCompound.size >= maxScopes && order.length > 0) {
      const oldestKey = order.shift();
      if (oldestKey !== undefined) {
        const removed = scopesByCompound.get(oldestKey);
        if (removed !== undefined) {
          scopesByCompound.delete(oldestKey);
          removeBranchMapping(removed.branchId, oldestKey);
          note(`scope_registry_evicted: ${oldestKey}`);
        }
      }
    }
  };

  const pruneInternal = (currentNow: number): number => {
    let pruned = 0;
    for (const [key, scope] of [...scopesByCompound.entries()]) {
      if (isExpired(scope, currentNow)) {
        removeInternal(key);
        pruned += 1;
      }
    }
    return pruned;
  };

  return {
    get isDisposed(): boolean {
      return disposed;
    },

    register(spec: ScopeRegistrationSpec): ScopeRegistrationHandle {
      if (disposed) {
        throw new Error('ScopeRegistry has been disposed.');
      }
      const sessionId = typeof spec.sessionId === 'string' ? spec.sessionId.trim() : '';
      const branchId = typeof spec.branchId === 'string' ? spec.branchId.trim() : '';
      if (sessionId.length === 0 || branchId.length === 0) {
        throw new Error('ScopeRegistry.register requires non-empty sessionId and branchId.');
      }

      const currentTime = now();
      pruneInternal(currentTime);

      const compoundKey = formatScopeKey(sessionId, branchId);
      const isInvariant =
        spec.role === 'invariant' ||
        spec.guidance === 'guidance_free' ||
        spec.origin === 'explore_invariant' ||
        isInvariantScopeName(branchId);

      const role: ScopeRole = isInvariant ? 'invariant' : (spec.role ?? 'domain');
      const guidance: GuidanceMode = isInvariant ? 'guidance_free' : (spec.guidance ?? 'memory');
      // Invariant branches strictly forbid advice injection!
      const allowAdvice = isInvariant ? false : (spec.allowAdvice ?? true);

      const ttl = typeof spec.ttlMs === 'number' && spec.ttlMs > 0 ? spec.ttlMs : defaultTtlMs;
      const expiresAt = ttl > 0 ? currentTime + ttl : undefined;

      // Evict if at capacity and registering new key
      if (!scopesByCompound.has(compoundKey)) {
        evictOldestIfNeeded();
      } else {
        // Remove existing from order to refresh position
        const idx = order.indexOf(compoundKey);
        if (idx >= 0) {
          order.splice(idx, 1);
        }
      }

      const scope: RegisteredScope = Object.freeze({
        scopeKey: compoundKey,
        sessionId,
        branchId,
        ...(spec.namespace ? { namespace: spec.namespace.trim() } : {}),
        role,
        ...(spec.origin ? { origin: spec.origin } : {}),
        guidance,
        allowAdvice,
        isInvariant,
        createdAt: currentTime,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(spec.metadata ? { metadata: Object.freeze({ ...spec.metadata }) } : {})
      });

      scopesByCompound.set(compoundKey, scope);
      addBranchMapping(branchId, compoundKey);
      order.push(compoundKey);

      let handleDisposed = false;
      const handle: ScopeRegistrationHandle = {
        scope,
        dispose(): void {
          if (!handleDisposed && !disposed) {
            handleDisposed = true;
            removeInternal(compoundKey);
          }
        },
        unregister(): void {
          this.dispose();
        }
      };

      return handle;
    },

    unregister(scopeKeyOrBranchId: string): boolean {
      if (disposed) return false;
      if (scopesByCompound.has(scopeKeyOrBranchId)) {
        return removeInternal(scopeKeyOrBranchId);
      }
      const set = branchToCompounds.get(scopeKeyOrBranchId);
      if (set !== undefined && set.size === 1) {
        const compoundKey = set.values().next().value;
        if (compoundKey !== undefined) {
          return removeInternal(compoundKey);
        }
      }
      return false;
    },

    resolve(...payloads: readonly unknown[]): RegisteredScope | 'unknown' {
      if (disposed || payloads.length === 0) {
        return 'unknown';
      }
      const currentTime = now();
      const identity = extractScopeIdentity(...payloads);

      // Multiple conflicting sessions or branches -> ambiguous, return 'unknown' (F6)
      if (identity.sessionIds.size > 1 || identity.branchIds.size > 1) {
        return 'unknown';
      }

      // Exact compound key match (sessionId + branchId)
      if (identity.sessionIds.size === 1 && identity.branchIds.size === 1) {
        const sId = identity.sessionIds.values().next().value;
        const bId = identity.branchIds.values().next().value;
        if (sId !== undefined && bId !== undefined) {
          const key = formatScopeKey(sId, bId);
          const candidate = scopesByCompound.get(key);
          if (candidate !== undefined) {
            if (isExpired(candidate, currentTime)) {
              removeInternal(key);
              return 'unknown';
            }
            return candidate;
          }
        }
        return 'unknown';
      }

      // Branch-only lookup ONLY when session is absent and branchId is globally unique in registry
      if (identity.sessionIds.size === 0 && identity.branchIds.size === 1) {
        const bId = identity.branchIds.values().next().value;
        if (bId !== undefined) {
          const set = branchToCompounds.get(bId);
          if (set !== undefined && set.size === 1) {
            const compoundKey = set.values().next().value;
            if (compoundKey !== undefined) {
              const candidate = scopesByCompound.get(compoundKey);
              if (candidate !== undefined) {
                if (isExpired(candidate, currentTime)) {
                  removeInternal(compoundKey);
                  return 'unknown';
                }
                return candidate;
              }
            }
          }
        }
        return 'unknown';
      }

      return 'unknown';
    },

    get(scopeKeyOrBranchId: string): RegisteredScope | undefined {
      if (disposed) return undefined;
      let candidate = scopesByCompound.get(scopeKeyOrBranchId);
      if (candidate === undefined) {
        const set = branchToCompounds.get(scopeKeyOrBranchId);
        if (set !== undefined && set.size === 1) {
          const compoundKey = set.values().next().value;
          if (compoundKey !== undefined) {
            candidate = scopesByCompound.get(compoundKey);
          }
        }
      }
      if (candidate === undefined) return undefined;
      if (isExpired(candidate, now())) {
        removeInternal(candidate.scopeKey);
        return undefined;
      }
      return candidate;
    },

    has(scopeKeyOrBranchId: string): boolean {
      return this.get(scopeKeyOrBranchId) !== undefined;
    },

    activeScopes(): readonly RegisteredScope[] {
      if (disposed) return [];
      const currentTime = now();
      pruneInternal(currentTime);
      return [...scopesByCompound.values()];
    },

    prune(at?: number): number {
      if (disposed) return 0;
      return pruneInternal(at ?? now());
    },

    size(): number {
      if (disposed) return 0;
      pruneInternal(now());
      return scopesByCompound.size;
    },

    clear(): void {
      scopesByCompound.clear();
      branchToCompounds.clear();
      order.length = 0;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      scopesByCompound.clear();
      branchToCompounds.clear();
      order.length = 0;
    }
  };
}
