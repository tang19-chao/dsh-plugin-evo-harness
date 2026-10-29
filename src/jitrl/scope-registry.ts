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
 *
 * ADR 0006 (host identity, trust and mount isolation) adds to this module and
 * states the rule it must never break:
 *
 * - RULE: a sessionId NEVER stands in for a branch identity. A dispatch that
 *   names only a session cannot resolve to any branch scope (it is counted as
 *   `sessionOnlyRejected` instead of being matched on the shared session), and
 *   a host scope never authorizes a branch (its `authorizesBranch` is the
 *   literal `false`).
 * - Identity reading: {@link classifyScopeIdentity} is the vocabulary for
 *   deciding whether a payload proves a branch, names a session only, is
 *   ambiguous, or carries nothing at all.
 * - Trusted host scope: {@link ScopeRegistry.registerHostScope} records the
 *   host's OWN identity from an explicit, non-empty grant. It is the sanctioned
 *   replacement for the fail-open "unattributable dispatch is host-local"
 *   shortcut and the provenance host-class mounts are recorded against.
 *
 * Every outcome is counted (payload-free) so a fail-closed path is observable
 * rather than silent: {@link ScopeRegistry.stats}.
 *
 * P4-B (leases and registry integrity) adds the bounded-time half of the same
 * contract:
 *
 * - {@link ScopeRegistry.acquireLease} is the ONLY way to hold a branch scope
 *   for a bounded time. When the caller owns an agent object, the lease lives
 *   behind a WeakMap keyed by that object, so the registry never keeps the agent
 *   alive (and never stores it); a second acquire for the same carrier
 *   SUPERSEDES the first, and the superseded lease can no longer release the
 *   new one.
 * - Registrations are versioned per compound key: disposing a handle whose
 *   registration was replaced is a counted no-op, so a late dispose can never
 *   delete a newer registration.
 * - Invariant provenance is sticky and key-level: re-registering a key can
 *   upgrade to invariant but never downgrade (role/guidance/allowAdvice keep
 *   the stricter value) — the downgrade is counted, not silently applied.
 * - A sessionId lease ({@link ScopeRegistry.acquireSessionLease}) is granted
 *   ONLY when single occupancy is re-derived from live state (one live branch
 *   scope and one live branch lease for that session) and it is invalidated as
 *   soon as a second occupant appears. Single occupancy is never assumed.
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

// ---------------------------------------------------------------------------
// ADR 0006 D-P4-2: identity reading vocabulary
// ---------------------------------------------------------------------------

/**
 * How a payload set's identity reads out. The five statuses are exhaustive and
 * mutually exclusive ({@link classifyScopeIdentity} returns exactly one).
 *
 * `branch-and-session` / `branch-only` are the only statuses that PROVE a
 * branch. `session-only` names a session without a branch — under ADR 0006 it
 * must never be treated as a branch identity, and it is the exact shape a
 * sibling probe shares with its host session, so it is the leak this rule
 * closes. `ambiguous` names more than one branch or session (conflicting
 * claims); `unattributed` names nothing at all.
 */
export type ScopeIdentityStatus =
  | 'branch-and-session'
  | 'branch-only'
  | 'session-only'
  | 'ambiguous'
  | 'unattributed';

/** Payload-free reading of the identity a dispatch carries. */
export interface ScopeIdentityReading {
  readonly status: ScopeIdentityStatus;
  readonly branchId?: string;
  readonly sessionId?: string;
  readonly branchCount: number;
  readonly sessionCount: number;
  /** True only when exactly one branchId is named: the authority a branch mount needs. */
  readonly hasBranchProof: boolean;
}

/** Classify the identity reachable from the given payloads (ADR 0006 D-P4-2). */
export function classifyScopeIdentity(...payloads: readonly unknown[]): ScopeIdentityReading {
  const { branchIds, sessionIds } = extractScopeIdentity(...payloads);
  const branchCount = branchIds.size;
  const sessionCount = sessionIds.size;
  if (branchCount > 1 || sessionCount > 1) {
    return { status: 'ambiguous', branchCount, sessionCount, hasBranchProof: false };
  }
  const branchId = branchCount === 1 ? [...branchIds][0] : undefined;
  const sessionId = sessionCount === 1 ? [...sessionIds][0] : undefined;
  if (branchId !== undefined && sessionId !== undefined) {
    return { status: 'branch-and-session', branchId, sessionId, branchCount, sessionCount, hasBranchProof: true };
  }
  if (branchId !== undefined) {
    return { status: 'branch-only', branchId, branchCount, sessionCount, hasBranchProof: true };
  }
  if (sessionId !== undefined) {
    return { status: 'session-only', sessionId, branchCount, sessionCount, hasBranchProof: false };
  }
  return { status: 'unattributed', branchCount, sessionCount, hasBranchProof: false };
}

// ---------------------------------------------------------------------------
// ADR 0006 D-P4-3: trusted host scope
// ---------------------------------------------------------------------------

/** Input for an explicit host-identity registration. */
export interface HostScopeRegistrationSpec {
  /** The host's own session id, supplied by the host integrator (never inferred). */
  readonly sessionId: string;
  /** Optional host namespace the integrator declares as its own. */
  readonly namespace?: string;
  /** Non-empty provenance of the grant, e.g. 'permanent-patch:patch-7' or 'integrator:host-session'. */
  readonly grantedBy: string;
  /** TTL in milliseconds; defaults to the registry default TTL. */
  readonly ttlMs?: number;
  /** Custom metadata (trusted). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * An immutable host-scope record.
 *
 * `authorizesBranch` is the literal `false` on the type: a host scope is a
 * session/namespace statement only. Nothing can read a branch identity out of
 * it, which is how "sessionId must not secretly carry branch identity" is
 * enforced structurally instead of by convention.
 */
export interface RegisteredHostScope {
  readonly hostScopeKey: string;
  readonly sessionId: string;
  readonly namespace?: string;
  readonly grantedBy: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly authorizesBranch: false;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Disposer handle returned by ScopeRegistry.registerHostScope(). */
export interface HostScopeHandle {
  readonly scope: RegisteredHostScope;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// P4-B: bounded-time leases (WeakMap-carried, versioned, TTL-counted)
// ---------------------------------------------------------------------------

/**
 * Carrier-keyed leases live behind a WeakMap. A carrier is any agent/context
 * object the host already owns; the registry stores a token for it, NEVER the
 * object itself, so holding a lease cannot keep an agent alive.
 */
export type LeaseCarrier = object;

/** How a branch lease is keyed. */
export type BranchLeaseKind = 'carrier' | 'key';

/** Input for {@link ScopeRegistry.acquireLease}. */
export interface BranchLeaseSpec {
  readonly sessionId: string;
  readonly branchId: string;
  readonly namespace?: string;
  readonly role?: ScopeRole;
  readonly origin?: string;
  readonly guidance?: GuidanceMode;
  readonly allowAdvice?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Bounded lifetime; defaults to the registry TTL. */
  readonly ttlMs?: number;
  /** Agent/context carrier object. When present the lease is WeakMap-keyed. */
  readonly carrier?: LeaseCarrier;
}

/** One live (or historically resolvable) branch lease handle. */
export interface BranchLease {
  readonly leaseId: string;
  readonly kind: BranchLeaseKind;
  readonly scope: RegisteredScope;
  readonly acquiredAt: number;
  readonly expiresAt?: number;
  /** A renewal keeps the same scope and extends the lifetime (counted). */
  renew(ttlMs?: number): boolean;
  /** Idempotent; false (and counted as stale) when already released/superseded/expired. */
  release(): boolean;
  /** False once released, superseded, expired, invalidated or the registry is disposed. */
  readonly isActive: boolean;
}

/** Payload-free snapshot of one branch lease (never the carrier object). */
export interface BranchLeaseSummary {
  readonly leaseId: string;
  readonly kind: BranchLeaseKind;
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly acquiredAt: number;
  readonly expiresAt?: number;
  readonly active: boolean;
}

/** Input for {@link ScopeRegistry.acquireSessionLease}. */
export interface SessionLeaseRequest {
  readonly sessionId: string;
  /** Non-empty provenance (who authorized the bounded host-session occupancy). */
  readonly grantedBy: string;
  /** Non-empty human-readable reason. */
  readonly reason: string;
  readonly ttlMs?: number;
}

/**
 * A sessionId lease. `authorizesBranch` is the literal `false` (ADR 0006
 * D-P4-1): it proves bounded single occupancy of a host session, never a branch.
 */
export interface SessionLease {
  readonly leaseId: string;
  readonly sessionId: string;
  /** The single proven occupant this lease was derived from. */
  readonly branchId: string;
  readonly grantedBy: string;
  readonly reason: string;
  readonly acquiredAt: number;
  readonly expiresAt?: number;
  readonly authorizesBranch: false;
  readonly isActive: boolean;
  release(): boolean;
}

/** Why a sessionId lease was refused (fail-closed, never an assumption). */
export type SessionLeaseRefusalCode =
  | 'identity-required'
  | 'single-occupancy-unproven'
  | 'session-lease-active'
  | 'registry-disposed';

export interface SessionLeaseRefusal {
  readonly ok: false;
  readonly code: SessionLeaseRefusalCode;
  readonly details: {
    readonly liveScopes: number;
    readonly liveBranchLeases: number;
    readonly liveSessionLeases: number;
  };
}

export type SessionLeaseResult = { readonly ok: true; readonly lease: SessionLease } | SessionLeaseRefusal;

/** Payload-free resolve/registration counters (ADR 0006: fail-closed must be countable). */
export interface ScopeResolveCounters {
  readonly total: number;
  readonly proven: number;
  /** Proven through a branch-only payload whose branchId is globally unique in the registry. */
  readonly branchOnlyMatches: number;
  readonly unknown: number;
  /** Session-only payloads refused: the shared-session leak this rule closes. */
  readonly sessionOnlyRejected: number;
  readonly ambiguousRejected: number;
  readonly unattributedRejected: number;
  readonly unregisteredRejected: number;
  readonly expiredRejected: number;
}

export interface ScopeRegistryCounters {
  readonly registrations: number;
  /** Re-registrations that replaced a live scope at the same compound key. */
  readonly registrationsReplaced: number;
  /** Re-registrations whose only effect was keeping the existing invariant shape. */
  readonly stickyInvariantKept: number;
  /** Re-registrations that upgraded a domain key to invariant (allowed). */
  readonly invariantUpgrades: number;
  /** Re-registrations that asked for weaker provenance than the live record (never applied). */
  readonly downgradePrevented: number;
  /** Handles disposed after their registration was already replaced (counted no-op). */
  readonly staleDisposeNoop: number;
  readonly hostScopeRegistrations: number;
  /** registerHostScope calls rejected for a missing sessionId/grantedBy. */
  readonly hostScopeRejections: number;
  readonly evictions: number;
  readonly expiredPruned: number;
  readonly resolves: ScopeResolveCounters;
  readonly hostScopeResolves: {
    readonly total: number;
    readonly proven: number;
    readonly rejected: number;
  };
  /**
   * Lease accounting. Every acquired lease ends in exactly one of
   * released / expired / superseded / invalidated, or is still live, so
   * `acquired === released + expired + superseded + invalidated + live.branchLeases`.
   */
  readonly leases: {
    readonly acquired: number;
    readonly renewed: number;
    readonly released: number;
    readonly expired: number;
    /** A newer acquire for the SAME carrier/key replaced it. */
    readonly superseded: number;
    /** Lost its scope (evicted/removed/cleared/disposed) without being released. */
    readonly invalidated: number;
    /** release()/renew() on an already-terminated lease (counted, never applied). */
    readonly staleReleases: number;
    readonly staleRenewals: number;
    readonly sessionGranted: number;
    readonly sessionReleased: number;
    readonly sessionExpired: number;
    /** A second occupant appeared: the proof stopped holding, the lease died. */
    readonly sessionInvalidated: number;
    /** acquireSessionLease refusals, by structured code. */
    readonly sessionRefused: {
      readonly 'identity-required': number;
      readonly 'single-occupancy-unproven': number;
      readonly 'session-lease-active': number;
      readonly 'registry-disposed': number;
    };
    readonly sweepRuns: number;
  };
  /** Live gauges (not cumulative). */
  readonly live: {
    readonly branchLeases: number;
    readonly carrierLeases: number;
    readonly keyLeases: number;
    readonly sessionLeases: number;
  };
}

/**
 * The re-derived single-occupancy proof a sessionId lease depends on.
 *
 * `proven` is a CURRENT FACT computed from live state, never an assumption:
 * exactly one live branch scope for the session AND exactly one live branch
 * lease bound to it AND no other live session lease. Every mutation
 * (register/acquire/release/sweep) recomputes it and invalidates a lease whose
 * proof no longer holds.
 */
export interface SingleOccupancyProof {
  readonly sessionId: string;
  readonly proven: boolean;
  readonly liveScopes: number;
  readonly liveBranchLeases: number;
  readonly liveSessionLeases: number;
  /** The single live occupant branch, when `proven`. */
  readonly occupantBranchId?: string;
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
  /**
   * Acquire a bounded-time branch lease. With a `carrier` object the lease is
   * WeakMap-keyed (the registry never stores or retains the object); a second
   * acquire for the same carrier/key supersedes the previous lease.
   */
  acquireLease(spec: BranchLeaseSpec): BranchLease;
  /** Payload-free branch lease snapshot (live leases only; never the carrier). */
  leases(): readonly BranchLeaseSummary[];
  /**
   * Acquire a sessionId lease ONLY when single occupancy is provable from live
   * state (one live branch scope + one live branch lease for the session, and no
   * other session lease). Never assumed; invalidated when a second occupant
   * appears.
   */
  acquireSessionLease(request: SessionLeaseRequest): SessionLeaseResult;
  /** Live session leases (bounded single-occupancy proofs). */
  activeSessionLeases(): readonly SessionLease[];
  /** Re-derive the single-occupancy proof a session lease depends on. */
  sessionLeaseProof(sessionId: string): SingleOccupancyProof;
  /** Release every expired scope/lease/host-scope/session-lease; returns the count. */
  sweepExpired(at?: number): number;
  /** Register the host's OWN identity from an explicit grant (ADR 0006 D-P4-3). */
  registerHostScope(spec: HostScopeRegistrationSpec): HostScopeHandle;
  /** Resolve a dispatch to a trusted host scope, or 'unknown' (fail-closed). */
  resolveHostScope(...payloads: readonly unknown[]): RegisteredHostScope | 'unknown';
  /** Live host scopes in registration order. */
  activeHostScopes(): readonly RegisteredHostScope[];
  /** Cumulative payload-free counters; never reset by clear()/prune(). */
  stats(): ScopeRegistryCounters;
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

/**
 * Internal lease record. Deliberately holds NO carrier object: a carrier-keyed
 * lease keeps only a `WeakRef`, so the registry can never keep an agent alive
 * and a collected carrier is observable as an unresolvable weak reference.
 */
interface LeaseRecord {
  readonly leaseId: string;
  readonly kind: BranchLeaseKind;
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly acquiredAt: number;
  expiresAt?: number;
  active: boolean;
  termination?: 'released' | 'expired' | 'superseded' | 'invalidated';
  readonly carrierRef?: WeakRef<LeaseCarrier>;
}

/** Internal session-lease record (bounded single-occupancy proof). */
interface SessionLeaseRecord {
  readonly leaseId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly grantedBy: string;
  readonly reason: string;
  readonly acquiredAt: number;
  expiresAt?: number;
  active: boolean;
  termination?: 'released' | 'expired' | 'invalidated';
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

  // --- ADR 0006: counters + trusted host scopes -----------------------------
  // Cumulative, payload-free counters. clear()/prune() reset the DATA, never
  // the counters: a reset counter would hide a fail-closed path from the host.
  const counters = {
    registrations: 0,
    registrationsReplaced: 0,
    stickyInvariantKept: 0,
    invariantUpgrades: 0,
    downgradePrevented: 0,
    staleDisposeNoop: 0,
    hostScopeRegistrations: 0,
    hostScopeRejections: 0,
    evictions: 0,
    expiredPruned: 0,
    resolves: { total: 0, proven: 0, branchOnlyMatches: 0, unknown: 0, sessionOnlyRejected: 0, ambiguousRejected: 0, unattributedRejected: 0, unregisteredRejected: 0, expiredRejected: 0 },
    hostScopeResolves: { total: 0, proven: 0, rejected: 0 },
    leases: {
      acquired: 0,
      renewed: 0,
      released: 0,
      expired: 0,
      superseded: 0,
      invalidated: 0,
      staleReleases: 0,
      staleRenewals: 0,
      sessionGranted: 0,
      sessionReleased: 0,
      sessionExpired: 0,
      sessionInvalidated: 0,
      sessionRefused: { 'identity-required': 0, 'single-occupancy-unproven': 0, 'session-lease-active': 0, 'registry-disposed': 0 },
      sweepRuns: 0
    }
  };
  // Map from hostScopeKey (sessionId) to the registered host scope.
  const hostScopes = new Map<string, RegisteredHostScope>();
  const hostScopeOrder: string[] = [];

  const removeHostScopeInternal = (hostScopeKey: string): boolean => {
    const existing = hostScopes.get(hostScopeKey);
    if (existing === undefined) {
      return false;
    }
    hostScopes.delete(hostScopeKey);
    const idx = hostScopeOrder.indexOf(hostScopeKey);
    if (idx >= 0) {
      hostScopeOrder.splice(idx, 1);
    }
    return true;
  };

  const pruneHostScopes = (currentNow: number): number => {
    let pruned = 0;
    for (const key of [...hostScopes.keys()]) {
      const scope = hostScopes.get(key);
      if (scope !== undefined && scope.expiresAt !== undefined && scope.expiresAt <= currentNow) {
        removeHostScopeInternal(key);
        pruned += 1;
      }
    }
    return pruned;
  };

  /** Bump one bucket in the resolve counters; the closure invariant lives in ONE place. */
  const countResolve = (bucket: keyof typeof counters.resolves & string): void => {
    counters.resolves.total += 1;
    if (bucket === 'proven' || bucket === 'branchOnlyMatches') {
      counters.resolves.proven += 1;
      if (bucket === 'branchOnlyMatches') {
        counters.resolves.branchOnlyMatches += 1;
      }
    } else {
      counters.resolves.unknown += 1;
      counters.resolves[bucket] += 1;
    }
  };

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
    // P4-B: removing a scope invalidates the registrations that named it (their
    // handles become stale no-ops) AND every lease bound to it.
    bumpRegistrationVersion(compoundKey);
    invalidateLeasesForScope(compoundKey);
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
          bumpRegistrationVersion(oldestKey);
          invalidateLeasesForScope(oldestKey);
          counters.evictions += 1;
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
        counters.expiredPruned += 1;
        pruned += 1;
      }
    }
    pruned += pruneHostScopes(currentNow);
    // A session lease is a CURRENT FACT about live state: re-derive it after
    // every prune so a lapsed occupancy can never be read as a live proof.
    validateSessionLeases(currentNow);
    return pruned;
  };

  // --- P4-B: versioned registrations + bounded-time leases ------------------
  //
  // Registration versions: a handle owns exactly the version it created, so a
  // late dispose of a replaced registration is a counted no-op and can never
  // delete the newer one.
  const registrationVersion = new Map<string, number>();
  let nextRegistrationVersion = 0;
  const bumpRegistrationVersion = (compoundKey: string): number => {
    nextRegistrationVersion += 1;
    registrationVersion.set(compoundKey, nextRegistrationVersion);
    return nextRegistrationVersion;
  };

  // Branch leases: the record map is a normal Map of payload-free records (no
  // carrier object!). The carrier -> leaseId link is a WeakMap, so the registry
  // cannot keep an agent alive and the association disappears with the object.
  const leaseRecords = new Map<string, LeaseRecord>();
  const carrierLeases = new WeakMap<LeaseCarrier, string>();
  const keyLeaseByKey = new Map<string, string>();
  let nextLeaseId = 0;

  // Session leases: at most one per session, and only while single occupancy
  // is provable from live state (see proofOf / validateSessionLeases).
  const sessionLeaseRecords = new Map<string, SessionLeaseRecord>();
  let nextSessionLeaseId = 0;

  const terminateLease = (
    record: LeaseRecord,
    why: 'released' | 'expired' | 'superseded' | 'invalidated'
  ): void => {
    if (record.termination !== undefined) {
      return;
    }
    record.termination = why;
    record.active = false;
    leaseRecords.delete(record.leaseId);
    if (why === 'released') {
      counters.leases.released += 1;
    } else if (why === 'expired') {
      counters.leases.expired += 1;
    } else if (why === 'superseded') {
      counters.leases.superseded += 1;
    } else {
      counters.leases.invalidated += 1;
    }
    if (record.kind === 'key') {
      if (keyLeaseByKey.get(record.scopeKey) === record.leaseId) {
        keyLeaseByKey.delete(record.scopeKey);
      }
    } else {
      const carrier = record.carrierRef?.deref();
      if (carrier !== undefined && carrierLeases.get(carrier) === record.leaseId) {
        carrierLeases.delete(carrier);
      }
    }
    note('scope_lease_terminated: ' + record.kind + ' (' + why + ')');
  };

  const terminateSessionLease = (
    record: SessionLeaseRecord,
    why: 'released' | 'expired' | 'invalidated'
  ): void => {
    if (record.termination !== undefined) {
      return;
    }
    record.termination = why;
    record.active = false;
    sessionLeaseRecords.delete(record.sessionId);
    if (why === 'released') {
      counters.leases.sessionReleased += 1;
    } else if (why === 'expired') {
      counters.leases.sessionExpired += 1;
    } else {
      counters.leases.sessionInvalidated += 1;
    }
    note('scope_session_lease_terminated: ' + why);
  };

  /** Every lease bound to a scope dies with it (eviction, unregister, clear). */
  const invalidateLeasesForScope = (compoundKey: string): void => {
    for (const record of [...leaseRecords.values()]) {
      if (record.scopeKey === compoundKey) {
        terminateLease(record, 'invalidated');
      }
    }
  };

  /**
   * Re-derive single occupancy for a session from LIVE state. `proven` is a
   * fact, never an assumption: exactly one live branch scope, exactly one live
   * branch lease bound to that branch, and no other live session lease.
   */
  const proofOf = (
    sessionId: string,
    currentNow: number,
    options: { readonly branchId?: string; readonly excludeSessionLeaseId?: string } = {}
  ): SingleOccupancyProof => {
    let liveScopes = 0;
    let occupantBranchId: string | undefined;
    for (const scope of scopesByCompound.values()) {
      if (scope.sessionId === sessionId && !isExpired(scope, currentNow)) {
        liveScopes += 1;
        occupantBranchId = scope.branchId;
      }
    }
    let liveBranchLeases = 0;
    for (const record of leaseRecords.values()) {
      if (record.sessionId !== sessionId) {
        continue;
      }
      if (options.branchId !== undefined && record.branchId !== options.branchId) {
        continue;
      }
      liveBranchLeases += 1;
    }
    let liveSessionLeases = 0;
    for (const record of sessionLeaseRecords.values()) {
      if (record.sessionId === sessionId && record.leaseId !== options.excludeSessionLeaseId) {
        liveSessionLeases += 1;
      }
    }
    const proven =
      liveScopes === 1 &&
      liveBranchLeases === 1 &&
      liveSessionLeases === 0 &&
      (options.branchId === undefined || occupantBranchId === options.branchId);
    return {
      sessionId,
      proven,
      liveScopes,
      liveBranchLeases,
      liveSessionLeases,
      ...(proven && occupantBranchId !== undefined ? { occupantBranchId } : {})
    };
  };

  /**
   * Invalidate every session lease whose proof no longer holds. Called after
   * every mutation (register/acquire/release/sweep/prune): a second occupant
   * appearing is detected here, not discovered later.
   */
  const validateSessionLeases = (currentNow: number): void => {
    for (const record of [...sessionLeaseRecords.values()]) {
      if (record.termination !== undefined) {
        continue;
      }
      if (record.expiresAt !== undefined && record.expiresAt <= currentNow) {
        terminateSessionLease(record, 'expired');
        continue;
      }
      const proof = proofOf(record.sessionId, currentNow, {
        branchId: record.branchId,
        excludeSessionLeaseId: record.leaseId
      });
      if (!proof.proven) {
        terminateSessionLease(record, 'invalidated');
      }
    }
  };

  const makeLeaseHandle = (record: LeaseRecord, scope: RegisteredScope): BranchLease => ({
    leaseId: record.leaseId,
    kind: record.kind,
    scope,
    acquiredAt: record.acquiredAt,
    get expiresAt(): number | undefined {
      return record.expiresAt;
    },
    get isActive(): boolean {
      if (disposed) {
        return false;
      }
      // Lazy expiry at the observation point: reading a lapsed lease TERMINATES
      // it (counted exactly once) instead of reporting a stale `true`.
      if (record.active && record.expiresAt !== undefined && record.expiresAt <= now()) {
        terminateLease(record, 'expired');
      }
      return record.active;
    },
    renew(ttlMs?: number): boolean {
      if (!record.active || disposed) {
        counters.leases.staleRenewals += 1;
        return false;
      }
      const ttl = typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : defaultTtlMs;
      record.expiresAt = now() + ttl;
      counters.leases.renewed += 1;
      return true;
    },
    release(): boolean {
      if (!record.active) {
        counters.leases.staleReleases += 1;
        return false;
      }
      terminateLease(record, 'released');
      validateSessionLeases(now());
      return true;
    }
  });

  const makeSessionLeaseHandle = (record: SessionLeaseRecord): SessionLease => ({
    leaseId: record.leaseId,
    sessionId: record.sessionId,
    branchId: record.branchId,
    grantedBy: record.grantedBy,
    reason: record.reason,
    acquiredAt: record.acquiredAt,
    get expiresAt(): number | undefined {
      return record.expiresAt;
    },
    authorizesBranch: false,
    get isActive(): boolean {
      if (disposed) {
        return false;
      }
      // The proof is re-derived here too: a session lease can never be read as
      // active after a second occupant appeared, even if no mutation noticed yet.
      validateSessionLeases(now());
      return record.active;
    },
    release(): boolean {
      if (!record.active) {
        counters.leases.staleReleases += 1;
        return false;
      }
      terminateSessionLease(record, 'released');
      return true;
    }
  });

  /**
   * Register (or re-register) one compound key and return the frozen scope plus
   * the version that owns it. Shared by register() and acquireLease() so a lease
   * always has an authoritative scope behind it.
   *
   * Re-registration is additive in ONE direction only: a key may upgrade to
   * invariant, never downgrade. The invariant/advice-free shape is sticky at the
   * key level, and every prevented downgrade is counted instead of applied.
   */
  const registerScopeInternal = (spec: ScopeRegistrationSpec): {
    readonly scope: RegisteredScope;
    readonly compoundKey: string;
    readonly version: number;
  } => {
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
    const existing = scopesByCompound.get(compoundKey);
    const requestedInvariant =
      spec.role === 'invariant' ||
      spec.guidance === 'guidance_free' ||
      spec.origin === 'explore_invariant' ||
      isInvariantScopeName(branchId);

    // Sticky, key-level provenance (P4-B): invariant is a floor, not a mode.
    const isInvariant = requestedInvariant || (existing?.isInvariant ?? false);
    if (existing !== undefined) {
      counters.registrationsReplaced += 1;
      if (existing.isInvariant || existing.allowAdvice === false) {
        counters.stickyInvariantKept += 1;
      }
      if (existing.isInvariant && !requestedInvariant) {
        counters.downgradePrevented += 1;
      } else if (!existing.isInvariant && requestedInvariant) {
        counters.invariantUpgrades += 1;
      }
      if (!isInvariant && existing.allowAdvice === false && spec.allowAdvice === true) {
        counters.downgradePrevented += 1;
      }
      if (!isInvariant && existing.guidance === 'guidance_free' && spec.guidance === 'memory') {
        counters.downgradePrevented += 1;
      }
    }

    const role: ScopeRole = isInvariant ? 'invariant' : (spec.role ?? 'domain');
    const guidance: GuidanceMode =
      isInvariant || existing?.guidance === 'guidance_free'
        ? 'guidance_free'
        : (spec.guidance ?? 'memory');
    // Invariant branches strictly forbid advice injection, and a key that was
    // already advice-free can never become advice-bearing.
    const allowAdvice =
      isInvariant || existing?.allowAdvice === false ? false : (spec.allowAdvice ?? true);

    const ttl = typeof spec.ttlMs === 'number' && spec.ttlMs > 0 ? spec.ttlMs : defaultTtlMs;
    const expiresAt = ttl > 0 ? currentTime + ttl : undefined;

    // Evict if at capacity and registering new key
    if (existing === undefined) {
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
    counters.registrations += 1;

    return { scope, compoundKey, version: bumpRegistrationVersion(compoundKey) };
  };

  return {
    get isDisposed(): boolean {
      return disposed;
    },

    register(spec: ScopeRegistrationSpec): ScopeRegistrationHandle {
      if (disposed) {
        throw new Error('ScopeRegistry has been disposed.');
      }
      const { scope, compoundKey, version } = registerScopeInternal(spec);
      let handleDisposed = false;
      const handle: ScopeRegistrationHandle = {
        scope,
        dispose(): void {
          if (handleDisposed) {
            return;
          }
          handleDisposed = true;
          if (disposed) {
            return;
          }
          // Version check: a handle may only release the registration it owns.
          // A late dispose of a replaced registration is a counted no-op and can
          // never delete the newer one (P4-B).
          if (registrationVersion.get(compoundKey) !== version || scopesByCompound.get(compoundKey) !== scope) {
            counters.staleDisposeNoop += 1;
            note('scope_registration_stale_dispose: the handle no longer owns ' + compoundKey);
            return;
          }
          removeInternal(compoundKey);
        },
        unregister(): void {
          this.dispose();
        }
      };

      return handle;
    },

    acquireLease(spec: BranchLeaseSpec): BranchLease {
      if (disposed) {
        throw new Error('ScopeRegistry has been disposed.');
      }
      const carrier = spec.carrier;
      if (carrier !== undefined && (typeof carrier !== 'object' || carrier === null)) {
        throw new Error('BranchLeaseSpec.carrier must be an object when provided.');
      }
      const sessionId = typeof spec.sessionId === 'string' ? spec.sessionId.trim() : '';
      const branchId = typeof spec.branchId === 'string' ? spec.branchId.trim() : '';
      if (sessionId.length === 0 || branchId.length === 0) {
        throw new Error('ScopeRegistry.register requires non-empty sessionId and branchId.');
      }
      const currentTime = now();
      pruneInternal(currentTime);
      const compoundKey = formatScopeKey(sessionId, branchId);
      // ATTACH-OR-REGISTER: when a live scope already exists for this key (for
      // example registered by a host-adapter mount), the lease ATTACHES to it
      // instead of re-registering. Re-registering would bump the key's version
      // and turn the owner's own handle into a stale no-op, so an adapter could
      // never release what a lease observed. A lease therefore never steals
      // ownership of a key; it only claims a bounded interest in it.
      // The lease TTL bounds the LEASE only; the scope keeps its own lifetime.
      const existingScope = scopesByCompound.get(compoundKey);
      const scope =
        existingScope ??
        registerScopeInternal({ ...spec, ttlMs: undefined }).scope;

      // Supersede whatever held this carrier (WeakMap) or this key before.
      const previousLeaseId =
        carrier !== undefined ? carrierLeases.get(carrier) : keyLeaseByKey.get(compoundKey);
      if (previousLeaseId !== undefined) {
        const previous = leaseRecords.get(previousLeaseId);
        if (previous !== undefined) {
          terminateLease(previous, 'superseded');
        }
      }

      nextLeaseId += 1;
      const ttl = typeof spec.ttlMs === 'number' && spec.ttlMs > 0 ? spec.ttlMs : defaultTtlMs;
      const record: LeaseRecord = {
        leaseId: 'lease-' + String(nextLeaseId),
        kind: carrier !== undefined ? 'carrier' : 'key',
        scopeKey: compoundKey,
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        acquiredAt: currentTime,
        ...(ttl > 0 ? { expiresAt: currentTime + ttl } : {}),
        active: true,
        // The ONLY link to the carrier: a weak reference, never the object.
        ...(carrier !== undefined ? { carrierRef: new WeakRef(carrier) } : {})
      };
      leaseRecords.set(record.leaseId, record);
      if (carrier !== undefined) {
        carrierLeases.set(carrier, record.leaseId);
      } else {
        keyLeaseByKey.set(compoundKey, record.leaseId);
      }
      counters.leases.acquired += 1;
      // A new occupant appeared: every session proof is re-derived NOW.
      validateSessionLeases(currentTime);
      return makeLeaseHandle(record, scope);
    },

    leases(): readonly BranchLeaseSummary[] {
      return [...leaseRecords.values()].map((record) => ({
        leaseId: record.leaseId,
        kind: record.kind,
        scopeKey: record.scopeKey,
        sessionId: record.sessionId,
        branchId: record.branchId,
        acquiredAt: record.acquiredAt,
        ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
        active: record.active
      }));
    },

    acquireSessionLease(request: SessionLeaseRequest): SessionLeaseResult {
      const emptyDetails = { liveScopes: 0, liveBranchLeases: 0, liveSessionLeases: 0 };
      const refuse = (
        code: SessionLeaseRefusalCode,
        details: SessionLeaseRefusal['details']
      ): SessionLeaseResult => {
        counters.leases.sessionRefused[code] += 1;
        note('scope_session_lease_refused: ' + code);
        return { ok: false, code, details };
      };
      if (disposed) {
        return refuse('registry-disposed', emptyDetails);
      }
      const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : '';
      const grantedBy = typeof request.grantedBy === 'string' ? request.grantedBy.trim() : '';
      const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
      if (sessionId.length === 0) {
        return refuse('identity-required', emptyDetails);
      }
      if (grantedBy.length === 0 || reason.length === 0) {
        throw new Error(
          'ScopeRegistry.acquireSessionLease requires a non-empty grantedBy and reason (explicit authorization, ADR 0006 D-P4-5).'
        );
      }
      const currentTime = now();
      pruneInternal(currentTime);
      if (sessionLeaseRecords.has(sessionId)) {
        return refuse('session-lease-active', proofOf(sessionId, currentTime));
      }
      // PROOF, not assumption: exactly one live scope + one live branch lease.
      const proof = proofOf(sessionId, currentTime);
      if (!proof.proven || proof.occupantBranchId === undefined) {
        return refuse('single-occupancy-unproven', {
          liveScopes: proof.liveScopes,
          liveBranchLeases: proof.liveBranchLeases,
          liveSessionLeases: proof.liveSessionLeases
        });
      }
      nextSessionLeaseId += 1;
      const ttl = typeof request.ttlMs === 'number' && request.ttlMs > 0 ? request.ttlMs : defaultTtlMs;
      const record: SessionLeaseRecord = {
        leaseId: 'session-lease-' + String(nextSessionLeaseId),
        sessionId,
        branchId: proof.occupantBranchId,
        grantedBy,
        reason,
        acquiredAt: currentTime,
        ...(ttl > 0 ? { expiresAt: currentTime + ttl } : {}),
        active: true
      };
      sessionLeaseRecords.set(sessionId, record);
      counters.leases.sessionGranted += 1;
      return { ok: true, lease: makeSessionLeaseHandle(record) };
    },

    activeSessionLeases(): readonly SessionLease[] {
      if (disposed) {
        return [];
      }
      validateSessionLeases(now());
      return [...sessionLeaseRecords.values()].map((record) => makeSessionLeaseHandle(record));
    },

    sessionLeaseProof(sessionId: string): SingleOccupancyProof {
      const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
      return proofOf(trimmed, now());
    },

    sweepExpired(at?: number): number {
      if (disposed) {
        return 0;
      }
      const currentTime = typeof at === 'number' && Number.isFinite(at) ? at : now();
      counters.leases.sweepRuns += 1;
      const prunedScopes = pruneInternal(currentTime);
      let expiredLeases = 0;
      for (const record of [...leaseRecords.values()]) {
        if (record.expiresAt !== undefined && record.expiresAt <= currentTime) {
          terminateLease(record, 'expired');
          expiredLeases += 1;
        }
      }
      for (const record of [...sessionLeaseRecords.values()]) {
        if (record.expiresAt !== undefined && record.expiresAt <= currentTime) {
          terminateSessionLease(record, 'expired');
          expiredLeases += 1;
        }
      }
      validateSessionLeases(currentTime);
      return prunedScopes + expiredLeases;
    },

    unregister(scopeKeyOrBranchId: string): boolean {
      if (disposed) return false;
      if (scopesByCompound.has(scopeKeyOrBranchId)) {
        const removed = removeInternal(scopeKeyOrBranchId);
        validateSessionLeases(now());
        return removed;
      }
      const set = branchToCompounds.get(scopeKeyOrBranchId);
      if (set !== undefined && set.size === 1) {
        const compoundKey = set.values().next().value;
        if (compoundKey !== undefined) {
          const removed = removeInternal(compoundKey);
          validateSessionLeases(now());
          return removed;
        }
      }
      return false;
    },

    resolve(...payloads: readonly unknown[]): RegisteredScope | 'unknown' {
      if (disposed) {
        // A disposed registry observes nothing: every outcome stays uncounted.
        return 'unknown';
      }
      const currentTime = now();
      if (payloads.length === 0) {
        countResolve('unattributedRejected');
        return 'unknown';
      }
      const identity = extractScopeIdentity(...payloads);

      // Multiple conflicting sessions or branches -> ambiguous, return 'unknown' (F6)
      if (identity.sessionIds.size > 1 || identity.branchIds.size > 1) {
        countResolve('ambiguousRejected');
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
              counters.expiredPruned += 1;
              validateSessionLeases(currentTime);
              countResolve('expiredRejected');
              return 'unknown';
            }
            countResolve('proven');
            return candidate;
          }
        }
        countResolve('unregisteredRejected');
        return 'unknown';
      }

      // Branch-only lookup ONLY when session is absent and branchId is globally unique in registry
      if (identity.sessionIds.size === 0 && identity.branchIds.size === 1) {
        const bId = identity.branchIds.values().next().value;
        if (bId !== undefined) {
          const set = branchToCompounds.get(bId);
          if (set !== undefined && set.size > 1) {
            // The same branchId is registered under more than one session, so a
            // branch-only payload cannot say which compound it means.
            countResolve('ambiguousRejected');
            return 'unknown';
          }
          if (set !== undefined && set.size === 1) {
            const compoundKey = set.values().next().value;
            if (compoundKey !== undefined) {
              const candidate = scopesByCompound.get(compoundKey);
              if (candidate !== undefined) {
                if (isExpired(candidate, currentTime)) {
                  removeInternal(compoundKey);
                  counters.expiredPruned += 1;
                  validateSessionLeases(currentTime);
                  countResolve('expiredRejected');
                  return 'unknown';
                }
                countResolve('branchOnlyMatches');
                return candidate;
              }
            }
          }
        }
        countResolve('unregisteredRejected');
        return 'unknown';
      }

      // ADR 0006 D-P4-1 / D-P4-4: a sessionId NEVER stands in for a branch
      // identity. A session-only payload (the exact shape a sibling probe
      // shares with its host session) is refused and counted instead of being
      // matched on the shared session; so is a payload with no provable
      // identity at all. Branch authority is the only match path.
      if (identity.sessionIds.size === 1 && identity.branchIds.size === 0) {
        countResolve('sessionOnlyRejected');
        return 'unknown';
      }
      countResolve('unattributedRejected');
      return 'unknown';
    },

    registerHostScope(spec: HostScopeRegistrationSpec): HostScopeHandle {
      if (disposed) {
        throw new Error('ScopeRegistry has been disposed.');
      }
      const sessionId = typeof spec.sessionId === 'string' ? spec.sessionId.trim() : '';
      const grantedBy = typeof spec.grantedBy === 'string' ? spec.grantedBy.trim() : '';
      if (sessionId.length === 0 || grantedBy.length === 0) {
        // Counted BEFORE the throw: a rejected host registration is an
        // observation about the caller, not about host state.
        counters.hostScopeRejections += 1;
        throw new Error(
          'ScopeRegistry.registerHostScope requires a non-empty sessionId and an explicit grantedBy (ADR 0006 D-P4-3).'
        );
      }
      const currentTime = now();
      pruneHostScopes(currentTime);
      const hostScopeKey = sessionId;
      const ttl = typeof spec.ttlMs === 'number' && spec.ttlMs > 0 ? spec.ttlMs : defaultTtlMs;
      const expiresAt = ttl > 0 ? currentTime + ttl : undefined;
      const scope: RegisteredHostScope = Object.freeze({
        hostScopeKey,
        sessionId,
        ...(spec.namespace && spec.namespace.trim().length > 0 ? { namespace: spec.namespace.trim() } : {}),
        grantedBy,
        createdAt: currentTime,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        authorizesBranch: false as const,
        ...(spec.metadata ? { metadata: Object.freeze({ ...spec.metadata }) } : {})
      });
      hostScopes.set(hostScopeKey, scope);
      hostScopeOrder.push(hostScopeKey);
      counters.hostScopeRegistrations += 1;
      let handleDisposed = false;
      return {
        scope,
        dispose(): void {
          if (!handleDisposed && !disposed) {
            handleDisposed = true;
            removeHostScopeInternal(hostScopeKey);
          }
        }
      };
    },

    resolveHostScope(...payloads: readonly unknown[]): RegisteredHostScope | 'unknown' {
      if (disposed || payloads.length === 0) {
        if (!disposed && payloads.length === 0) {
          counters.hostScopeResolves.total += 1;
          counters.hostScopeResolves.rejected += 1;
        }
        return 'unknown';
      }
      counters.hostScopeResolves.total += 1;
      const identity = extractScopeIdentity(...payloads);
      const currentTime = now();
      // Ambiguous or branch-attributed payloads are not the host: a host scope
      // never covers a dispatch that names a branch (ADR 0006 D-P4-3).
      if (identity.sessionIds.size !== 1 || identity.branchIds.size > 0) {
        counters.hostScopeResolves.rejected += 1;
        return 'unknown';
      }
      const sId = identity.sessionIds.values().next().value;
      if (sId === undefined) {
        counters.hostScopeResolves.rejected += 1;
        return 'unknown';
      }
      const scope = hostScopes.get(sId);
      if (scope === undefined) {
        counters.hostScopeResolves.rejected += 1;
        return 'unknown';
      }
      if (scope.expiresAt !== undefined && scope.expiresAt <= currentTime) {
        removeHostScopeInternal(sId);
        counters.expiredPruned += 1;
        counters.hostScopeResolves.rejected += 1;
        return 'unknown';
      }
      counters.hostScopeResolves.proven += 1;
      return scope;
    },

    activeHostScopes(): readonly RegisteredHostScope[] {
      if (disposed) return [];
      pruneHostScopes(now());
      return [...hostScopes.values()];
    },

    stats(): ScopeRegistryCounters {
      // Live gauges are derived from the record maps, so they can never drift.
      let carrierLeasesLive = 0;
      let keyLeasesLive = 0;
      for (const record of leaseRecords.values()) {
        if (record.kind === 'carrier') {
          carrierLeasesLive += 1;
        } else {
          keyLeasesLive += 1;
        }
      }
      // Deep-frozen snapshot: a caller cannot mutate the live counters, and a
      // mutation test can prove the snapshot drifts instead of aliasing.
      return Object.freeze({
        registrations: counters.registrations,
        registrationsReplaced: counters.registrationsReplaced,
        stickyInvariantKept: counters.stickyInvariantKept,
        invariantUpgrades: counters.invariantUpgrades,
        downgradePrevented: counters.downgradePrevented,
        staleDisposeNoop: counters.staleDisposeNoop,
        hostScopeRegistrations: counters.hostScopeRegistrations,
        hostScopeRejections: counters.hostScopeRejections,
        evictions: counters.evictions,
        expiredPruned: counters.expiredPruned,
        resolves: Object.freeze({ ...counters.resolves }),
        hostScopeResolves: Object.freeze({ ...counters.hostScopeResolves }),
        leases: Object.freeze({
          ...counters.leases,
          sessionRefused: Object.freeze({ ...counters.leases.sessionRefused })
        }),
        live: Object.freeze({
          branchLeases: carrierLeasesLive + keyLeasesLive,
          carrierLeases: carrierLeasesLive,
          keyLeases: keyLeasesLive,
          sessionLeases: sessionLeaseRecords.size
        })
      });
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
        counters.expiredPruned += 1;
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
      // A lease whose scope is being dropped is INVALIDATED (not released): the
      // counter stays closed and no caller can read a live proof afterwards.
      for (const record of [...leaseRecords.values()]) {
        terminateLease(record, 'invalidated');
      }
      for (const record of [...sessionLeaseRecords.values()]) {
        terminateSessionLease(record, 'invalidated');
      }
      scopesByCompound.clear();
      branchToCompounds.clear();
      order.length = 0;
      registrationVersion.clear();
      keyLeaseByKey.clear();
      hostScopes.clear();
      hostScopeOrder.length = 0;
    },

    dispose(): void {
      if (disposed) return;
      for (const record of [...leaseRecords.values()]) {
        terminateLease(record, 'invalidated');
      }
      for (const record of [...sessionLeaseRecords.values()]) {
        terminateSessionLease(record, 'invalidated');
      }
      disposed = true;
      scopesByCompound.clear();
      branchToCompounds.clear();
      order.length = 0;
      registrationVersion.clear();
      keyLeaseByKey.clear();
      hostScopes.clear();
      hostScopeOrder.length = 0;
    }
  };
}
