/**
 * rev5 P2-3/P2-4: the two-tier safety gate for PROBE tool calls.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two independent fences already exist in the codebase but were never composed:
 *   - tier 1: `ToolFaceRegistry` (src/cordis-seams/tool-face.ts) — a per-branch,
 *     read-only tool allowlist enforced on the host's `tools/pre-execute` hook;
 *   - tier 2: `ProbeAuthorizationLedger` (src/jitrl/runtime-control.ts) — explicit,
 *     reasoned, revocable grants for actions that change state outside the probe
 *     (external tool call, memory write, paid model call, ...).
 *
 * A probe can reach BOTH: the hook sees host-dispatched tool calls, while a
 * multi-step probe executed by `createAgentLoopExecutor` calls its own tool
 * runtime directly and therefore never passes the hook. This module is the one
 * place where the two are combined for that second path, with these rules:
 *
 *   1. INERT BY DEFAULT. With neither fence configured the gate allows every
 *      call *without fabricating counters* (`checks: 0`). A host that never
 *      opted in behaves exactly as it did before this module existed.
 *   2. TIER 1 FIRST, THEN TIER 2. A call must pass the allowlist AND, when a
 *      ledger is attached, hold a grant. The first refusal wins, so the code
 *      names the cheapest reason.
 *   3. BRANCH CALLS HAVE NO "NO POLICY" PASS. `ToolFaceRegistry.decide` is
 *      transparent outside a policy by design (host-level calls). For a
 *      BRANCH-scoped probe request that transparency would mean running an
 *      unfenced probe recommended by JitRL, so it is refused with code
 *      `no-policy` and counted in `branchNoPolicy`. On a correctly assembled
 *      path (a policy installed for the branch) that counter MUST stay 0 — the
 *      tests assert exactly that, and `validateProbeSafetyCounters` fails a
 *      snapshot where it is not.
 *   4. DISPOSAL CLOSES THE GATE. A disposed registry or ledger denies; it never
 *      falls open.
 *   5. NO THROWS INTO THE PROBE. `decide` returns a decision; the executor turns
 *      a refusal into a structured tool error the model can see.
 */
import {
  type ProbeAuthorizationDecision,
  type ProbeAuthorizationKind,
  type ProbeAuthorizationLedger
} from '../jitrl/runtime-control';
import type { ToolFaceCode, ToolFaceDecision, ToolFaceRegistry } from '../cordis-seams/tool-face';

/** Every code this gate can report (allowlist codes, ledger codes, and its own). */
export const PROBE_SAFETY_CODES = [
  'unconfigured',
  'invalid-request',
  'allowlisted',
  'not-allowlisted',
  'explicitly-denied',
  'no-policy',
  'out-of-scope',
  'registry-disposed',
  'authorized',
  'no-grant',
  'grant-expired',
  'identity-required',
  'session-cannot-authorize-branch',
  'grant-scope-mismatch',
  'ledger-disposed'
] as const;
export type ProbeSafetyCode = (typeof PROBE_SAFETY_CODES)[number];

/** Which fence produced the decision. */
export type ProbeSafetyTier = 'none' | 'allowlist' | 'authorization';

/** One tool call asking for permission. */
export interface ProbeSafetyRequest {
  readonly toolName: string;
  /** Absent means a host-level call (no branch fence). */
  readonly branchId?: string;
  readonly sessionId?: string;
}

/** Fail-closed answer for one tool call. */
export interface ProbeSafetyDecision {
  readonly allowed: boolean;
  readonly tier: ProbeSafetyTier;
  readonly code: ProbeSafetyCode;
  readonly toolName: string;
  readonly branchId?: string;
  readonly reason?: string;
  /** Present when tier 2 answered: the full grant decision. */
  readonly authorization?: ProbeAuthorizationDecision;
}

export interface ProbeSafetyCounters {
  readonly checks: number;
  readonly allowed: number;
  readonly denied: number;
  readonly branchChecks: number;
  readonly hostChecks: number;
  /**
   * BRANCH calls refused because no branch policy existed. Must be 0 on an
   * assembled path: a branch probe may never run unfenced.
   */
  readonly branchNoPolicy: number;
  readonly byCode: Readonly<Record<ProbeSafetyCode, number>>;
  readonly allowlistTier: { readonly checks: number; readonly allowed: number; readonly denied: number };
  readonly authorizationTier: { readonly checks: number; readonly allowed: number; readonly denied: number };
}

export interface ProbeSafetyPolicy {
  /** Tier 1. Absent = tier 1 not enforced (documented as inert, not as "passed"). */
  readonly toolFace?: ToolFaceRegistry;
  /** Tier 2. Absent = no grant required. */
  readonly ledger?: ProbeAuthorizationLedger;
  /** Action class asked of the ledger; defaults to 'external-tool-call'. */
  readonly authorizationKind?: ProbeAuthorizationKind;
  /** Payload-free diagnostics (tool names and branch ids are not payloads). */
  readonly onDiagnostic?: (message: string) => void;
}

export interface ProbeSafetyGate {
  /** True when at least one tier is enforced. */
  readonly configured: boolean;
  decide(request: ProbeSafetyRequest): ProbeSafetyDecision;
  stats(): ProbeSafetyCounters;
}

/** Validate a counters snapshot: closures and the branch-nopolicy invariant. */
export function validateProbeSafetyCounters(counters: ProbeSafetyCounters, options: { readonly policyInstalled: boolean }): readonly string[] {
  const problems: string[] = [];
  if (counters.checks !== counters.allowed + counters.denied) {
    problems.push('checks !== allowed + denied (' + String(counters.checks) + ' !== ' + String(counters.allowed + counters.denied) + ')');
  }
  if (counters.branchChecks + counters.hostChecks !== counters.checks) {
    problems.push('branchChecks + hostChecks !== checks');
  }
  const byCodeTotal = PROBE_SAFETY_CODES.reduce((sum, code) => sum + counters.byCode[code], 0);
  if (byCodeTotal !== counters.checks) {
    problems.push('byCode total !== checks (' + String(byCodeTotal) + ' !== ' + String(counters.checks) + ')');
  }
  if (options.policyInstalled && counters.branchNoPolicy !== 0) {
    problems.push(
      'a branch policy was installed but ' + String(counters.branchNoPolicy) + ' branch call(s) fell through to no-policy'
    );
  }
  return problems;
}

function emptyByCode(): Record<ProbeSafetyCode, number> {
  return Object.fromEntries(PROBE_SAFETY_CODES.map((code) => [code, 0])) as Record<ProbeSafetyCode, number>;
}

/**
 * Create the gate. Both fences are optional and are captured by reference, so a
 * host can attach the registry or ledger later and the gate sees it.
 */
export function createProbeSafetyGate(policy: ProbeSafetyPolicy = {}): ProbeSafetyGate {
  const note = (message: string): void => {
    policy.onDiagnostic?.(message);
  };
  const toolFace = policy.toolFace;
  const ledger = policy.ledger;
  const authorizationKind: ProbeAuthorizationKind = policy.authorizationKind ?? 'external-tool-call';
  const configured = toolFace !== undefined || ledger !== undefined;

  const counters = {
    checks: 0,
    allowed: 0,
    denied: 0,
    branchChecks: 0,
    hostChecks: 0,
    branchNoPolicy: 0,
    byCode: emptyByCode(),
    allowlistTier: { checks: 0, allowed: 0, denied: 0 },
    authorizationTier: { checks: 0, allowed: 0, denied: 0 }
  };

  const answer = (
    request: ProbeSafetyRequest,
    allowed: boolean,
    tier: ProbeSafetyTier,
    code: ProbeSafetyCode,
    extra: { readonly reason?: string; readonly authorization?: ProbeAuthorizationDecision } = {}
  ): ProbeSafetyDecision => {
    counters.checks += 1;
    counters.byCode[code] += 1;
    if (request.branchId === undefined) {
      counters.hostChecks += 1;
    } else {
      counters.branchChecks += 1;
    }
    if (allowed) {
      counters.allowed += 1;
    } else {
      counters.denied += 1;
    }
    if (!allowed && tier === 'allowlist' && request.branchId !== undefined && code === 'no-policy') {
      counters.branchNoPolicy += 1;
    }
    if (!allowed) {
      note('probe_safety_denied: ' + request.toolName + ' (' + tier + '/' + code + ')');
    }
    return {
      allowed,
      tier,
      code,
      toolName: request.toolName,
      ...(request.branchId === undefined ? {} : { branchId: request.branchId }),
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
      ...(extra.authorization === undefined ? {} : { authorization: extra.authorization })
    };
  };

  return {
    configured,

    decide(request: ProbeSafetyRequest): ProbeSafetyDecision {
      const toolName = typeof request.toolName === 'string' ? request.toolName.trim() : '';
      if (toolName.length === 0) {
        // A call with no name cannot be checked against any policy: deny, never
        // treat it as "outside the policy" and let it through.
        return answer({ ...request, toolName: '' }, false, 'allowlist', 'invalid-request', {
          reason: 'toolName is empty; an unnamed tool call cannot be allowlisted'
        });
      }

      // ---- tier 1: read-only allowlist ----------------------------------
      if (toolFace !== undefined) {
        counters.allowlistTier.checks += 1;
        if (toolFace.isDisposed) {
          counters.allowlistTier.denied += 1;
          return answer(request, false, 'allowlist', 'registry-disposed', {
            reason: 'the tool-face registry was disposed; the gate fails closed'
          });
        }
        const face: ToolFaceDecision = toolFace.decide({
          toolName,
          ...(request.branchId === undefined ? {} : { branchId: request.branchId }),
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId })
        });
        if (face.allowed !== true) {
          counters.allowlistTier.denied += 1;
          return answer(request, false, 'allowlist', face.code as ToolFaceCode as ProbeSafetyCode, {
            ...(face.reason === undefined ? {} : { reason: face.reason })
          });
        }
        if (face.code === 'no-policy' && request.branchId !== undefined) {
          // Transparent for host-level calls, but a BRANCH probe must be fenced.
          counters.allowlistTier.denied += 1;
          return answer(request, false, 'allowlist', 'no-policy', {
            reason: 'no tool-face policy is installed for this branch; a branch probe may not run unfenced'
          });
        }
        counters.allowlistTier.allowed += 1;
        if (ledger === undefined) {
          return answer(request, true, 'allowlist', face.allowed === true && face.code === 'allowlisted' ? 'allowlisted' : 'no-policy');
        }
      }

      // ---- tier 2: explicit authorization --------------------------------
      if (ledger !== undefined) {
        counters.authorizationTier.checks += 1;
        if (ledger.isDisposed) {
          counters.authorizationTier.denied += 1;
          return answer(request, false, 'authorization', 'ledger-disposed', {
            reason: 'the authorization ledger was disposed; the gate fails closed'
          });
        }
        const decision = ledger.authorize({
          kind: authorizationKind,
          ...(request.branchId === undefined ? {} : { branchId: request.branchId }),
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId })
        });
        if (decision.allowed !== true) {
          counters.authorizationTier.denied += 1;
          return answer(request, false, 'authorization', decision.code as ProbeSafetyCode, {
            reason: 'no authorization grant covers this ' + authorizationKind,
            authorization: decision
          });
        }
        counters.authorizationTier.allowed += 1;
        return answer(request, true, 'authorization', 'authorized', { authorization: decision });
      }

      // Only reachable with no fence at all (inert gate).
      return answer(request, true, 'none', 'unconfigured');
    },

    stats(): ProbeSafetyCounters {
      return {
        ...counters,
        byCode: { ...counters.byCode },
        allowlistTier: { ...counters.allowlistTier },
        authorizationTier: { ...counters.authorizationTier }
      };
    }
  };
}
