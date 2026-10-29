/**
 * Branch tool face (P4-C): an explicit tool ALLOWLIST, enforced in-process.
 *
 * What this IS
 * ------------
 * A cooperative, in-process fence. A tool call that PROVES a branchId is
 * checked against the policy installed for that branch; a tool that is not on
 * the list is denied with a structured code and counted
 * ({@link ToolFaceCounters}), never silently allowed. The policy is installed
 * per branch by whoever owns the branch (the seam manager does this for every
 * probe run), so a sibling branch and the host never share one allowlist.
 *
 * What this is NOT
 * ----------------
 * **Not a sandbox.** The check runs in the same process as the host, with the
 * same filesystem, network, environment and credentials. `ctx.fork` gives a
 * child Cordis context — a context boundary, not an OS boundary. A tool
 * implementation that ignores the pre-execute decision, or code that calls a
 * tool without going through `tools/pre-execute`, is NOT contained by this
 * module. Real containment needs the host's own permission layer or an
 * out-of-process sandbox; ADR 0006 D-P4-5 and
 * `docs/reports/p4-c-toolface.md` record that boundary explicitly, together
 * with the real-host smoke that stays **not-run** until authorized.
 *
 * Enforcement scope (fail-closed INSIDE a branch, transparent for the host)
 * -------------------------------------------------------------------------
 * - request proves a branchId with an installed policy: allowlist applies;
 *   an unlisted tool is DENIED and counted (`deniedNotAllowlisted`).
 * - request proves a branchId with NO policy: not enforced (`noPolicy`), and
 *   the absence is visible in the counters instead of looking like a pass.
 * - request proves no branchId (host call): `outOfScope` — a probe policy can
 *   never deny the host's own tools (that would be the opposite leak).
 * - registry disposed: a branch request is denied (`registry-disposed`).
 */

/** One installed branch policy. Immutable. */
export interface ToolFacePolicy {
  readonly policyId: string;
  readonly branchId: string;
  /** The ONLY tools callable in this branch; empty means nothing is callable. */
  readonly allowTools: readonly string[];
  readonly denies: readonly ToolFaceDenial[];
  readonly label?: string;
  readonly installedAt: number;
  readonly expiresAt?: number;
}

/** An explicit denial evaluated before the allowlist. */
export interface ToolFaceDenial {
  readonly toolName: string;
  readonly reason: string;
}

/** Input for {@link ToolFaceRegistry.install}. */
export interface ToolFacePolicySpec {
  readonly branchId: string;
  readonly allowTools: readonly string[];
  /** Extra explicit denials (the allowlist already denies everything else). */
  readonly denyTools?: readonly ToolFaceDenial[];
  readonly label?: string;
  /** Bounded lifetime; defaults to the registry TTL. */
  readonly ttlMs?: number;
}

export type ToolFaceCode =
  | 'allowlisted'
  | 'not-allowlisted'
  | 'explicitly-denied'
  | 'no-policy'
  | 'out-of-scope'
  | 'registry-disposed';

/** Fail-closed decision for one tool call. */
export interface ToolFaceDecision {
  readonly allowed: boolean;
  readonly code: ToolFaceCode;
  readonly toolName: string;
  readonly branchId?: string;
  readonly policyId?: string;
  readonly reason?: string;
}

export interface ToolFaceRequest {
  readonly toolName: string;
  /** The branch that PROVED the call; absent means a host-level call. */
  readonly branchId?: string;
  readonly sessionId?: string;
}

export interface ToolFaceCounters {
  readonly installations: number;
  readonly replacements: number;
  readonly removals: number;
  readonly evictions: number;
  readonly expiredPolicies: number;
  readonly checks: number;
  readonly allowed: number;
  readonly deniedNotAllowlisted: number;
  readonly deniedExplicit: number;
  readonly outOfScope: number;
  readonly noPolicy: number;
  readonly registryDisposed: number;
  /** Live policies (gauge). */
  readonly livePolicies: number;
}

export interface ToolFaceRegistryOptions {
  /** Maximum live policies retained concurrently (oldest evicted). Default 64. */
  readonly maxPolicies?: number;
  /** Default policy TTL in milliseconds. Default 30 min. */
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Payload-free diagnostic sink (tool names and branch ids are NOT payloads). */
  readonly onDiagnostic?: (message: string) => void;
}

export interface ToolFaceRegistry {
  /** Install (or replace) the policy for one branch. */
  install(spec: ToolFacePolicySpec): ToolFacePolicy;
  /** Remove the policy for a branch; idempotent. */
  remove(branchId: string): boolean;
  policyFor(branchId: string): ToolFacePolicy | undefined;
  policies(): readonly ToolFacePolicy[];
  /** Decide one tool call; deny-by-default inside a policy, transparent outside. */
  decide(request: ToolFaceRequest): ToolFaceDecision;
  /** Prune expired policies; returns the number removed. */
  sweepExpired(at?: number): number;
  stats(): ToolFaceCounters;
  dispose(): void;
  readonly isDisposed: boolean;
}

const EMPTY_COUNTERS: ToolFaceCounters = Object.freeze({
  installations: 0,
  replacements: 0,
  removals: 0,
  evictions: 0,
  expiredPolicies: 0,
  checks: 0,
  allowed: 0,
  deniedNotAllowlisted: 0,
  deniedExplicit: 0,
  outOfScope: 0,
  noPolicy: 0,
  registryDisposed: 0,
  livePolicies: 0
});

/** Create the per-branch tool face registry. */
export function createToolFaceRegistry(options: ToolFaceRegistryOptions = {}): ToolFaceRegistry {
  const maxPolicies = typeof options.maxPolicies === 'number' && options.maxPolicies > 0 ? options.maxPolicies : 64;
  const defaultTtlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : 1_800_000;
  const now = options.now ?? ((): number => Date.now());
  const note = (message: string): void => {
    options.onDiagnostic?.(message);
  };

  let disposed = false;
  let policySeq = 0;
  const policies = new Map<string, ToolFacePolicy>();
  const order: string[] = [];
  const counters = { ...EMPTY_COUNTERS } as {
    -readonly [K in keyof ToolFaceCounters]: ToolFaceCounters[K];
  };

  const isExpired = (policy: ToolFacePolicy, at: number): boolean =>
    policy.expiresAt !== undefined && policy.expiresAt <= at;

  const removeInternal = (branchId: string): boolean => {
    if (!policies.has(branchId)) {
      return false;
    }
    policies.delete(branchId);
    const index = order.indexOf(branchId);
    if (index >= 0) {
      order.splice(index, 1);
    }
    return true;
  };

  const policyForInternal = (branchId: string): ToolFacePolicy | undefined => {
    const policy = policies.get(branchId);
    if (policy === undefined) {
      return undefined;
    }
    if (isExpired(policy, now())) {
      removeInternal(branchId);
      counters.expiredPolicies += 1;
      return undefined;
    }
    return policy;
  };

  const sweep = (at: number): number => {
    let removed = 0;
    for (const [branchId, policy] of [...policies.entries()]) {
      if (isExpired(policy, at)) {
        removeInternal(branchId);
        counters.expiredPolicies += 1;
        removed += 1;
      }
    }
    return removed;
  };

  return {
    get isDisposed(): boolean {
      return disposed;
    },

    install(spec: ToolFacePolicySpec): ToolFacePolicy {
      if (disposed) {
        throw new Error('ToolFaceRegistry has been disposed.');
      }
      const branchId = typeof spec.branchId === 'string' ? spec.branchId.trim() : '';
      if (branchId.length === 0) {
        throw new Error('ToolFacePolicySpec.branchId must be a non-empty string.');
      }
      if (!Array.isArray(spec.allowTools)) {
        throw new Error('ToolFacePolicySpec.allowTools must be an array of tool names.');
      }
      const allowTools: string[] = [];
      for (const entry of spec.allowTools) {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
          throw new Error('ToolFacePolicySpec.allowTools entries must be non-empty tool names.');
        }
        const name = entry.trim();
        if (name === '*') {
          // A wildcard would turn the allowlist into a deny-only list; refuse it
          // so "allowlist" cannot silently mean "everything".
          throw new Error('ToolFacePolicySpec.allowTools must not contain "*": the allowlist is explicit.');
        }
        if (!allowTools.includes(name)) {
          allowTools.push(name);
        }
      }
      const denies: ToolFaceDenial[] = [];
      for (const denial of spec.denyTools ?? []) {
        if (typeof denial?.toolName !== 'string' || denial.toolName.trim().length === 0) {
          throw new Error('ToolFacePolicySpec.denyTools entries need a non-empty toolName.');
        }
        denies.push({
          toolName: denial.toolName.trim(),
          reason: typeof denial.reason === 'string' && denial.reason.trim().length > 0
            ? denial.reason.trim()
            : 'denied by the branch tool face'
        });
      }

      const currentTime = now();
      sweep(currentTime);
      const replaced = policies.has(branchId);
      if (replaced) {
        const index = order.indexOf(branchId);
        if (index >= 0) {
          order.splice(index, 1);
        }
        counters.replacements += 1;
      } else {
        while (policies.size >= maxPolicies && order.length > 0) {
          const oldest = order.shift();
          if (oldest !== undefined && removeInternal(oldest)) {
            counters.evictions += 1;
            note('tool_face_policy_evicted');
          }
        }
      }

      policySeq += 1;
      const ttl = typeof spec.ttlMs === 'number' && spec.ttlMs > 0 ? spec.ttlMs : defaultTtlMs;
      const policy: ToolFacePolicy = Object.freeze({
        policyId: 'toolface-' + String(policySeq),
        branchId,
        allowTools: Object.freeze(allowTools.slice()),
        denies: Object.freeze(denies.map((denial) => Object.freeze({ ...denial }))),
        ...(spec.label === undefined ? {} : { label: spec.label }),
        installedAt: currentTime,
        ...(ttl > 0 ? { expiresAt: currentTime + ttl } : {})
      });
      policies.set(branchId, policy);
      order.push(branchId);
      counters.installations += 1;
      note('tool_face_policy_installed: ' + allowTools.length + ' tool(s)');
      return policy;
    },

    remove(branchId: string): boolean {
      if (disposed) {
        return false;
      }
      const removed = removeInternal(typeof branchId === 'string' ? branchId.trim() : '');
      if (removed) {
        counters.removals += 1;
      }
      return removed;
    },

    policyFor(branchId: string): ToolFacePolicy | undefined {
      if (disposed) {
        return undefined;
      }
      return policyForInternal(typeof branchId === 'string' ? branchId.trim() : '');
    },

    policies(): readonly ToolFacePolicy[] {
      if (disposed) {
        return [];
      }
      sweep(now());
      return [...policies.values()];
    },

    decide(request: ToolFaceRequest): ToolFaceDecision {
      const toolName = typeof request.toolName === 'string' ? request.toolName.trim() : '';
      const branchId =
        typeof request.branchId === 'string' && request.branchId.trim().length > 0
          ? request.branchId.trim()
          : undefined;
      counters.checks += 1;
      if (disposed) {
        counters.registryDisposed += 1;
        return {
          allowed: false,
          code: 'registry-disposed',
          toolName,
          ...(branchId === undefined ? {} : { branchId }),
          reason: 'the tool face registry was disposed; a branch tool call cannot be authorized'
        };
      }
      if (branchId === undefined) {
        // A host-level call: a probe's allowlist must never deny the host.
        counters.outOfScope += 1;
        return { allowed: true, code: 'out-of-scope', toolName };
      }
      const policy = policyForInternal(branchId);
      if (policy === undefined) {
        counters.noPolicy += 1;
        return { allowed: true, code: 'no-policy', toolName, branchId };
      }
      const explicit = policy.denies.find((denial) => denial.toolName === toolName);
      if (explicit !== undefined) {
        counters.deniedExplicit += 1;
        note('tool_face_denied: explicitly-denied');
        return {
          allowed: false,
          code: 'explicitly-denied',
          toolName,
          branchId,
          policyId: policy.policyId,
          reason: explicit.reason
        };
      }
      if (policy.allowTools.includes(toolName)) {
        counters.allowed += 1;
        return { allowed: true, code: 'allowlisted', toolName, branchId, policyId: policy.policyId };
      }
      counters.deniedNotAllowlisted += 1;
      note('tool_face_denied: not-allowlisted');
      return {
        allowed: false,
        code: 'not-allowlisted',
        toolName,
        branchId,
        policyId: policy.policyId,
        reason: 'tool "' + toolName + '" is not on branch "' + branchId + '" allowlist (tool face, fail-closed)'
      };
    },

    sweepExpired(at?: number): number {
      if (disposed) {
        return 0;
      }
      return sweep(typeof at === 'number' && Number.isFinite(at) ? at : now());
    },

    stats(): ToolFaceCounters {
      return Object.freeze({
        installations: counters.installations,
        replacements: counters.replacements,
        removals: counters.removals,
        evictions: counters.evictions,
        expiredPolicies: counters.expiredPolicies,
        checks: counters.checks,
        allowed: counters.allowed,
        deniedNotAllowlisted: counters.deniedNotAllowlisted,
        deniedExplicit: counters.deniedExplicit,
        outOfScope: counters.outOfScope,
        noPolicy: counters.noPolicy,
        registryDisposed: counters.registryDisposed,
        livePolicies: policies.size
      });
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      policies.clear();
      order.length = 0;
      note('tool_face_registry_disposed');
    }
  };
}
