/**
 * Dream-RSI layer barrel.
 *
 * Ownership: src/dream-rsi/** (Wave 1, Dream-RSI layer). The integrator imports
 * this module from src/orchestrator.ts; nothing here touches the host, the
 * network, or a sandbox.
 */

export * from './discovery-tree';
export * from './failure-taxonomy';
export * from './surrogate-scorer';
export * from './active-policy';
// rev8 plan §6.1 P1: GridPlan resolver (fallback/clamp/out_of_support audit),
// ported from upstream dream_rsi/policy/grid_planning.py:88-162.
export * from './grid-plan-resolution';
// rev8 plan §6.1 item 3: the live-cycle manifest (cross-cycle realized-shape
// record). Its reserved barrel slot opens now that the orchestrator wiring has
// landed: the module is pure data + on-demand fs (like the persistence layer it
// sits on), so the barrel's "no side effects" statement stays true.
export * from './live-cycle-manifest';
export * from './offline-dreamer';
// rev6 audit A4-2: the trusted-evidence readiness floor for offline replay.
export * from './verified-tree-gate';
