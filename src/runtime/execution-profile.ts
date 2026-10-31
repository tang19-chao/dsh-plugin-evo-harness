/**
 * P6.2 C1 execution profile (ADR 0002 R1/R2; new module, 11.2 scope).
 *
 * The four-mode execution contract (baseline / shadow / guarded-active / off)
 * and the three permission layers (patch / publish / memory) as ONE resolved,
 * data-only profile. The plugin entrypoint resolves its config into this shape
 * and hands it to the orchestrator; the orchestrator enforces it; the status
 * page reports it. Every default here is fail-closed per the ADR:
 *
 *   - default execution mode: 'shadow' (baseline execution byte for byte +
 *     suggestion records; zero side effects);
 *   - patch permission (PERMANENT patch mount incl. the winning patch):
 *     denied unless the mode is 'guarded-active' - and even then only inside
 *     the evidence rules (the gate), never as a blanket allowance;
 *   - publish permission: NEVER granted in this round (any path);
 *   - memory permission: NEVER granted in this round (any path).
 *
 * Terminology note (ADR 0002 R1/t6): "host baseline" means the host's own
 * behaviour is untouched by Jit; "base evo search" is the reversible probing
 * INSIDE isolated branches, which is not the object of the patch permission.
 * Only a PERMANENT mount after probing needs the patch permission.
 */

/** The declared execution modes (contracts DecisionMode plus 'off'). */
export const EXECUTION_MODES = ['baseline', 'shadow', 'guarded-active', 'off'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** The three independent permission layers (ADR 0002 R2). */
export type PermissionLayer = 'patch' | 'publish' | 'memory';

/** One resolved permission: allow or deny, with the reason it resolved so. */
export interface PermissionDecision {
  readonly allowed: boolean;
  /** Why: an explicit resolution rule, in force for every caller. */
  readonly reason: string;
}

/** The resolved, fail-closed execution profile. */
export interface ExecutionProfile {
  readonly mode: ExecutionMode;
  /** Layer permissions, resolved per the ADR rules. */
  readonly permissions: Readonly<Record<PermissionLayer, PermissionDecision>>;
  /**
   * Whether the shadow suggestion records are emitted (prior/proposed/executed,
   * shrunk/calibrated strength, nEff/support, gateReason). True for 'shadow'
   * and 'guarded-active'; false for 'baseline' and 'off'.
   */
  readonly shadowRecords: boolean;
  /** True when the mode is 'off' (PR2 RuntimeControl seven surfaces stopped). */
  readonly off: boolean;
}

/** Explicit profile input (config-facing). */
export interface ExecutionProfileInput {
  /** Declared execution mode; default 'shadow' (the ADR default assembly). */
  readonly mode?: ExecutionMode;
  /**
   * t10/R2 (t9 blocker) + t12/R2-residual (t11 blocker): explicit REAL-memory
   * opt-in. `false`/absent (every config-resolved assembly) keeps
   * `permissions.memory.allowed === false` for all four modes - promote/mirror
   * and any real-namespace write are structurally unreachable (ADR 0002 §4:
   * "memory 本轮一律不真实写入"). The denial is enforced AT THE CALL SITE: the
   * orchestrator does not call the memory bridge at all under a denied
   * permission (no "ephemeral"/renamed scope substitution - a bridge that
   * accepts any scope would have persisted the write). Only an assembly that
   * EXPLICITLY passes `memoryRealWrites: true` in the profile input gets a
   * memory-allowed profile - a shape no config field can produce and no default
   * wiring ever builds. It exists so the deterministic TEST assemblies
   * (in-memory mock backends, e.g. the mirror/promotion suites) can keep
   * exercising the write machinery they were written for; a production host
   * gains nothing, because the plugin entrypoint never sets it. The override
   * is explicit profile DATA (not a string registrar): it is visible in
   * diagnostics (the config-vs-profile consistency check reports it) and
   * re-enabling real writes for production stays the captain's adjudication
   * (out of this round's scope by contract).
   */
  readonly memoryRealWrites?: boolean;
}

/** The documented ADR default: baseline execution + shadow records. */
export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'shadow';

/**
 * Resolve an execution profile. Unknown/unusable input fails closed: an
 * undeclared mode becomes 'shadow' (the default), and no input can produce
 * publish allowance.
 *
 * Patch permission semantics:
 *   - 'shadow' / 'baseline' / 'off': denied (no permanent mount, no
 *     auto-publish, no real memory write);
 *   - 'guarded-active': allowed ONLY as "evidence-gated" - the conservative
 *     replacement rules (src/jitrl/replacement-policy.ts) still decide every
 *     individual deviation. It is an enabling flag for the gate channel, not a
 *     blanket mount right.
 *
 * Memory permission semantics (t10/R2): denied in EVERY mode unless the
 * explicit `memoryRealWrites: true` profile override is present (see above).
 * Publish is never granted this round in any shape.
 */
export function resolveExecutionProfile(input: ExecutionProfileInput = {}): ExecutionProfile {
  const declared = input.mode;
  const mode: ExecutionMode =
    declared !== undefined && (EXECUTION_MODES as readonly string[]).includes(declared)
      ? declared
      : DEFAULT_EXECUTION_MODE;
  const off = mode === 'off';
  const shadowRecords = mode === 'shadow' || mode === 'guarded-active';
  const patchAllowed = mode === 'guarded-active';
  const memoryAllowed = input.memoryRealWrites === true;
  return {
    mode,
    permissions: {
      patch: {
        allowed: patchAllowed,
        reason: patchAllowed
          ? 'guarded-active explicitly enabled; every individual deviation still passes the replacement-evidence gate'
          : 'patch permission is denied unless guarded-active is explicitly enabled (ADR 0002 R2: fail-closed default)'
      },
      publish: {
        allowed: false,
        reason: 'publish is never granted in this round: holdout STRICT-IMPROVEMENT validation (winner hypervolume > baseline + epsilon on the held-out trees, ADR 0007 §2 - the earlier "non-inferiority" wording was drift) + explicit authorization + matching artifact are all required and none exists (ADR 0002 R2)'
      },
      memory: {
        allowed: memoryAllowed,
        reason: memoryAllowed
          ? 'memory writes allowed ONLY by the explicit ExecutionProfileInput.memoryRealWrites override (test assemblies); no config field can produce this profile'
          : 'real memory writes are never granted in this round (ADR 0002 R2); the mirror stays disabled by default'
      }
    },
    shadowRecords,
    off
  };
}

/**
 * Effective DecisionMode a record should carry for one run: 'off' runs still
 * record NOTHING (the runtime control stops the surfaces), so the profile
 * never maps 'off' onto a record mode. The orchestrator reads this only when
 * it is actually producing records.
 */
export function recordModeOf(mode: ExecutionMode): 'baseline' | 'shadow' | 'guarded-active' {
  return mode === 'off' ? 'baseline' : mode;
}
