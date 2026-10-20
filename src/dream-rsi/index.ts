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
export * from './offline-dreamer';
