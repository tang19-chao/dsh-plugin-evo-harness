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
