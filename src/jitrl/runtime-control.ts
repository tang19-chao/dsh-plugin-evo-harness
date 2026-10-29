/**
 * Single runtime control for every JitRL surface (plan P6 section 4 R1 / 5.1).
 *
 * Ownership: src/jitrl/runtime-control.ts (P6 PR2).
 *
 * Before this module the volatile `/evo jit off` switch was spread over four
 * unrelated objects (`jitWiring.runtimeEnabled` for L1, `runtimeGate.enabled`
 * for L3/mirror/host-tool, `volatileJitEnabled` in the command controller, and
 * a second `kernel.config.enabled` read inside the orchestrator). The last one
 * was static configuration, so `off` never reached the L2 selector or the
 * online recorder: the run kept producing `jit_meta_adjust` candidates, kept
 * calling the K-candidate proposer and kept appending experience (appendix A).
 *
 * This module is the ONE object every consumer shares. It deliberately keeps
 * two orthogonal facts apart:
 *
 * - `configured`     whether JitRL is available at all
 *                    (`config.jitrl.enabled && levels.includes('meta')`).
 *                    Static for the lifetime of the process; it is what
 *                    `plugin.jitrl.enabled` reports and NOT a volatile state.
 * - `runtimeEnabled` whether JitRL is switched on right now
 *                    (`configured && !disposed && desired`). `/evo jit off`
 *                    flips only this, and every surface reads it.
 *
 * `generation` starts at 1 and increments on every EFFECTIVE state change, so
 * a consumer that started an external effect (a model call) can tell that the
 * switch moved while that call was in flight and decline to publish the result.
 * The model call itself is never promised to be withdrawn - only the effects
 * that would follow it (decision publication, experience append, mirror write).
 */

/**
 * The JitRL surfaces the switch covers. Every one of them shares the same
 * volatile state today; the explicit list keeps producers and consumers on the
 * same vocabulary (and lets a future per-surface policy narrow it) instead of
 * re-inventing a bare boolean at each call site.
 */
export const JIT_SURFACES = [
  'meta',
  'proposal',
  'advisor',
  'onlineRecord',
  'hostRecord',
  'mirror',
  'dreamJit'
] as const;

/** One JitRL surface managed by the runtime control. */
export type JitSurface = (typeof JIT_SURFACES)[number];

/** Immutable view of the control, safe to hand to a status page. */
export interface JitRuntimeSnapshot {
  /** JitRL is available in this process (`config.jitrl.enabled` + `meta`). */
  readonly configured: boolean;
  /** JitRL may produce effects right now. Never conflate with `configured`. */
  readonly runtimeEnabled: boolean;
  /** Monotonic counter of effective state changes; starts at 1. */
  readonly generation: number;
}

/** The stable interface orchestrator, hooks, commands and status pages share. */
export interface JitRuntimeControl {
  snapshot(): JitRuntimeSnapshot;
  /** True when `surface` may produce an external effect right now. */
  isEnabled(surface: JitSurface): boolean;
}

/**
 * The writable side. Only the plugin entrypoint holds this: every other
 * consumer receives the read-only `JitRuntimeControl`.
 */
export interface MutableJitRuntimeControl extends JitRuntimeControl {
  /** Flip the volatile switch; returns the resulting snapshot. */
  setEnabled(enabled: boolean): JitRuntimeSnapshot;
  /** Permanently disable every surface (plugin teardown). Idempotent. */
  dispose(): void;
  /** True once dispose() ran; every surface is off from then on. */
  isDisposed(): boolean;
}

export interface JitRuntimeControlOptions {
  /** `config.jitrl.enabled && levels.includes('meta')` - static availability. */
  readonly configured: boolean;
  /** Initial volatile state; defaults to turned on. Ignored when unconfigured. */
  readonly enabled?: boolean;
}

const SURFACE_SET: ReadonlySet<string> = new Set(JIT_SURFACES);

/**
 * Create the process-wide runtime control.
 *
 * A control created with `configured: false` stays off no matter what
 * `setEnabled(true)` asks for, because "on" cannot mean more than "available".
 * An unknown surface is off (fail closed) so a typo cannot silently re-enable
 * an effect.
 */
export function createJitRuntimeControl(
  options: JitRuntimeControlOptions
): MutableJitRuntimeControl {
  const configured = options.configured === true;
  let desired = options.enabled !== false;
  let disposed = false;
  let generation = 1;

  const snapshot = (): JitRuntimeSnapshot => ({
    configured,
    runtimeEnabled: configured && desired && !disposed,
    generation
  });

  return {
    snapshot,
    isEnabled(surface: JitSurface): boolean {
      if (!SURFACE_SET.has(surface)) {
        return false;
      }
      return snapshot().runtimeEnabled;
    },
    setEnabled(enabled: boolean): JitRuntimeSnapshot {
      if (disposed) {
        return snapshot();
      }
      const before = snapshot().runtimeEnabled;
      desired = enabled === true;
      // Only an EFFECTIVE change bumps the generation: asking `on` while
      // already on (or `on` while unconfigured) is not a state change, and a
      // consumer that re-reads the generation must not see a phantom move.
      if (snapshot().runtimeEnabled !== before) {
        generation += 1;
      }
      return snapshot();
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      generation += 1;
    },
    isDisposed(): boolean {
      return disposed;
    }
  };
}


// ---------------------------------------------------------------------------
// ADR 0006 D-P4-5: explicit authorization ledger - same-process is NOT a sandbox
// ---------------------------------------------------------------------------

/**
 * The action classes that can never be authorized implicitly, by JitRL being
 * switched on, by a shared sessionId, or by running in the same process.
 *
 * ADR 0006 states: **a process is not a sandbox.** A probe shares the host's
 * memory, network and tool surface, so every action below changes state outside
 * the probe's own measurement world and needs a named human/system grant. This
 * module only *records and decides* grants; no call site is wired in P4-A (the
 * plugin entrypoint is outside that task's write scope), so production behavior
 * is unchanged and every required grant is an explicit future step.
 *
 * The ledger is deliberately independent of {@link createJitRuntimeControl}:
 * `runtimeEnabled: true` authorizes NOTHING here, and a disposed runtime does
 * not lift these requirements. Permission layering (ADR 0001 D4) is preserved.
 */
export const PROBE_AUTHORIZATION_KINDS = [
  'external-tool-call',
  'memory-write',
  'multi-step-probe',
  'real-host-smoke',
  'paid-model-call'
] as const;

export type ProbeAuthorizationKind = (typeof PROBE_AUTHORIZATION_KINDS)[number];

/** The action asking for authorization. */
export interface ProbeAuthorizationRequest {
  readonly kind: ProbeAuthorizationKind;
  /** The probe branch asking; branch-scoped requests need a branch-scoped grant. */
  readonly branchId?: string;
  /** A session identity. It NEVER substitutes for a branch identity (ADR 0006 D-P4-1). */
  readonly sessionId?: string;
}

export type ProbeAuthorizationCode =
  | 'authorized'
  | 'no-grant'
  | 'grant-expired'
  | 'identity-required'
  | 'session-cannot-authorize-branch'
  | 'grant-scope-mismatch'
  | 'ledger-disposed';

/** Fail-closed decision; `code` says exactly why an action was not authorized. */
export interface ProbeAuthorizationDecision {
  readonly allowed: boolean;
  readonly code: ProbeAuthorizationCode;
  readonly kind: ProbeAuthorizationKind;
  /** Set only for 'authorized': the grant that produced the decision. */
  readonly grantId?: string;
}

/** One recorded grant. Grants are explicit, reasoned and removable. */
export interface ProbeAuthorizationGrant {
  readonly grantId: string;
  readonly kind: ProbeAuthorizationKind;
  /** Non-empty provenance (operator, approved issue, signed scope document). */
  readonly grantedBy: string;
  /** Non-empty human-readable reason. */
  readonly reason: string;
  readonly branchId?: string;
  readonly sessionId?: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
  /** Single-use grants are consumed by the first allowed decision. */
  readonly singleUse: boolean;
  /** Set once a single-use grant was consumed; the grant no longer authorizes. */
  readonly usedAt?: number;
  readonly revokedAt?: number;
}

/** Input for creating a grant. Rejected when any required field is empty. */
export interface ProbeAuthorizationGrantSpec {
  readonly kind: ProbeAuthorizationKind;
  readonly grantedBy: string;
  readonly reason: string;
  /** Restricts the grant to exactly one probe branch. */
  readonly branchId?: string;
  /** Restricts the grant to one session (never a substitute for a branch). */
  readonly sessionId?: string;
  readonly ttlMs?: number;
  readonly singleUse?: boolean;
}

export interface ProbeAuthorizationCounters {
  readonly grants: number;
  readonly grantsRejected: number;
  readonly revocations: number;
  readonly checks: number;
  readonly allowed: number;
  readonly denied: number;
  /** Per denial code; closure `checks === allowed + denied` always holds. */
  readonly deniedByCode: Readonly<Record<Exclude<ProbeAuthorizationCode, 'authorized'>, number>>;
  readonly expiredGrants: number;
  /** Attempts to authorize a branch with a session-only grant (ADR 0006 D-P4-1). */
  readonly sessionCannotAuthorizeBranch: number;
}

export interface ProbeAuthorizationLedgerOptions {
  readonly now?: () => number;
  /** Payload-free diagnostic sink (grant/revoke/deny events, no identities). */
  readonly onDiagnostic?: (message: string) => void;
}

export interface ProbeAuthorizationLedger {
  /** Record a grant. Throws (after counting) on an unknown kind or empty provenance. */
  grant(spec: ProbeAuthorizationGrantSpec): ProbeAuthorizationGrant;
  revoke(grantId: string): boolean;
  /** Decide one request; default deny with a structured code. */
  authorize(request: ProbeAuthorizationRequest): ProbeAuthorizationDecision;
  /** Live grants in creation order. */
  grants(): readonly ProbeAuthorizationGrant[];
  /** Cumulative payload-free counters. */
  stats(): ProbeAuthorizationCounters;
  dispose(): void;
  readonly isDisposed: boolean;
}

const AUTHORIZATION_KIND_SET: ReadonlySet<string> = new Set(PROBE_AUTHORIZATION_KINDS);

const DENIAL_CODES: readonly Exclude<ProbeAuthorizationCode, 'authorized'>[] = [
  'no-grant',
  'grant-expired',
  'identity-required',
  'session-cannot-authorize-branch',
  'grant-scope-mismatch',
  'ledger-disposed'
];

/**
 * Create the authorization ledger. Every decision is deny-by-default: without a
 * matching, unexpired, non-revoked grant the answer is always `false`, and the
 * reason is one structured code instead of a silent allow.
 */
export function createProbeAuthorizationLedger(
  options: ProbeAuthorizationLedgerOptions = {}
): ProbeAuthorizationLedger {
  const now = options.now ?? ((): number => Date.now());
  const note = (message: string): void => {
    options.onDiagnostic?.(message);
  };

  let disposed = false;
  let grantSeq = 0;
  const grantsById = new Map<string, ProbeAuthorizationGrant>();
  const counters = {
    grants: 0,
    grantsRejected: 0,
    revocations: 0,
    checks: 0,
    allowed: 0,
    denied: 0,
    deniedByCode: Object.fromEntries(DENIAL_CODES.map((code) => [code, 0])) as Record<
      Exclude<ProbeAuthorizationCode, 'authorized'>,
      number
    >,
    expiredGrants: 0,
    sessionCannotAuthorizeBranch: 0
  };

  const denied = (
    code: Exclude<ProbeAuthorizationCode, 'authorized'>,
    kind: ProbeAuthorizationKind,
    grantId?: string
  ): ProbeAuthorizationDecision => {
    counters.checks += 1;
    counters.denied += 1;
    counters.deniedByCode[code] += 1;
    if (code === 'session-cannot-authorize-branch') {
      counters.sessionCannotAuthorizeBranch += 1;
    }
    note('probe_authorization_denied: ' + kind + ' (' + code + ')');
    return { allowed: false, code, kind, ...(grantId === undefined ? {} : { grantId }) };
  };

  const dropExpired = (currentTime: number): void => {
    for (const [id, grant] of [...grantsById.entries()]) {
      if (grant.expiresAt !== undefined && grant.expiresAt <= currentTime) {
        grantsById.delete(id);
        counters.expiredGrants += 1;
      }
    }
  };

  return {
    get isDisposed(): boolean {
      return disposed;
    },

    grant(spec: ProbeAuthorizationGrantSpec): ProbeAuthorizationGrant {
      if (disposed) {
        throw new Error('ProbeAuthorizationLedger has been disposed.');
      }
      const kind = spec.kind;
      const grantedBy = typeof spec.grantedBy === 'string' ? spec.grantedBy.trim() : '';
      const reason = typeof spec.reason === 'string' ? spec.reason.trim() : '';
      if (!AUTHORIZATION_KIND_SET.has(kind)) {
        counters.grantsRejected += 1;
        throw new Error('ProbeAuthorizationLedger.grant requires a known PROBE_AUTHORIZATION_KIND, received: ' + String(kind));
      }
      if (grantedBy.length === 0 || reason.length === 0) {
        counters.grantsRejected += 1;
        throw new Error('ProbeAuthorizationLedger.grant requires a non-empty grantedBy and reason (explicit authorization, ADR 0006 D-P4-5).');
      }
      if (spec.branchId !== undefined && typeof spec.branchId !== 'string') {
        counters.grantsRejected += 1;
        throw new Error('ProbeAuthorizationLedger.grant requires branchId to be a string.');
      }
      if (spec.sessionId !== undefined && typeof spec.sessionId !== 'string') {
        counters.grantsRejected += 1;
        throw new Error('ProbeAuthorizationLedger.grant requires sessionId to be a string.');
      }
      grantSeq += 1;
      const grantId = 'grant-' + String(grantSeq);
      const currentTime = now();
      const branchId = spec.branchId !== undefined && spec.branchId.trim().length > 0 ? spec.branchId.trim() : undefined;
      const sessionId = spec.sessionId !== undefined && spec.sessionId.trim().length > 0 ? spec.sessionId.trim() : undefined;
      const grant: ProbeAuthorizationGrant = Object.freeze({
        grantId,
        kind,
        grantedBy,
        reason,
        ...(branchId === undefined ? {} : { branchId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        createdAt: currentTime,
        ...(typeof spec.ttlMs === 'number' && spec.ttlMs > 0 ? { expiresAt: currentTime + spec.ttlMs } : {}),
        singleUse: spec.singleUse === true
      });
      grantsById.set(grantId, grant);
      counters.grants += 1;
      note('probe_authorization_granted: ' + kind + ' (' + grantId + ')');
      return grant;
    },

    revoke(grantId: string): boolean {
      if (disposed || grantsById.get(grantId) === undefined) {
        return false;
      }
      grantsById.delete(grantId);
      counters.revocations += 1;
      note('probe_authorization_revoked: ' + grantId);
      return true;
    },

    authorize(request: ProbeAuthorizationRequest): ProbeAuthorizationDecision {
      const kind = request.kind;
      if (!AUTHORIZATION_KIND_SET.has(kind)) {
        // An unknown kind is not a grantable action: deny, never guess.
        return denied('no-grant', kind);
      }
      if (disposed) {
        return denied('ledger-disposed', kind);
      }
      const branchId = typeof request.branchId === 'string' && request.branchId.trim().length > 0 ? request.branchId.trim() : undefined;
      const sessionId = typeof request.sessionId === 'string' && request.sessionId.trim().length > 0 ? request.sessionId.trim() : undefined;
      if (branchId === undefined && sessionId === undefined) {
        // Missing identity is fail-closed and counted: a grant cannot attach to
        // an action nobody can attribute.
        return denied('identity-required', kind);
      }
      const currentTime = now();
      // A grant that WOULD have matched but expired is reported as
      // 'grant-expired' instead of collapsing into 'no-grant', so a caller can
      // tell "never authorized" from "authorization lapsed" (and renew it).
      let expiredCandidate: ProbeAuthorizationGrant | undefined;
      for (const grant of grantsById.values()) {
        if (grant.kind !== kind) {
          continue;
        }
        if (grant.expiresAt !== undefined && grant.expiresAt <= currentTime) {
          expiredCandidate = expiredCandidate ?? grant;
          continue;
        }
        if (grant.branchId !== undefined) {
          // A branch-scoped grant covers exactly that branch and nothing else.
          if (branchId !== grant.branchId) {
            continue;
          }
        } else if (branchId !== undefined) {
          // A grant without a branchId can never authorize a branch-scoped
          // action, whatever session it names: sessionId is not a branch
          // identity (ADR 0006 D-P4-1).
          return denied('session-cannot-authorize-branch', kind, grant.grantId);
        }
        if (grant.sessionId !== undefined && sessionId !== undefined && grant.sessionId !== sessionId) {
          continue;
        }
        if (grant.usedAt !== undefined) {
          continue;
        }
        counters.checks += 1;
        counters.allowed += 1;
        if (grant.singleUse) {
          const consumed: ProbeAuthorizationGrant = Object.freeze({ ...grant, usedAt: currentTime });
          grantsById.set(grant.grantId, consumed);
        }
        note('probe_authorization_allowed: ' + kind + ' (' + grant.grantId + ')');
        return { allowed: true, code: 'authorized', kind, grantId: grant.grantId };
      }
      if (expiredCandidate !== undefined) {
        grantsById.delete(expiredCandidate.grantId);
        counters.expiredGrants += 1;
        return denied('grant-expired', kind, expiredCandidate.grantId);
      }
      return denied('no-grant', kind);
    },

    grants(): readonly ProbeAuthorizationGrant[] {
      dropExpired(now());
      return [...grantsById.values()];
    },

    stats(): ProbeAuthorizationCounters {
      return Object.freeze({
        grants: counters.grants,
        grantsRejected: counters.grantsRejected,
        revocations: counters.revocations,
        checks: counters.checks,
        allowed: counters.allowed,
        denied: counters.denied,
        deniedByCode: Object.freeze({ ...counters.deniedByCode }),
        expiredGrants: counters.expiredGrants,
        sessionCannotAuthorizeBranch: counters.sessionCannotAuthorizeBranch
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      grantsById.clear();
      note('probe_authorization_ledger_disposed');
    }
  };
}
