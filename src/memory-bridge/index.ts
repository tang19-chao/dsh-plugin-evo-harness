/**
 * Universal MCP Memory Bridge public surface (src/memory-bridge/**).
 *
 * The integrator (src/index.ts, src/orchestrator.ts) imports from here:
 *   createMemoryBridge({ config, clients, listClients, now })
 * plus the governance helpers and driver registry for advanced wiring.
 */

export * from './spi';
export * from './namespace';
export * from './script-syntax';
export * from './lesson-codec';
export * from './governance-polyfill';
export * from './drivers/index';
export * from './auto-discovery';
export * from './bridge';
export * from './status';

import { createMemoryBridge } from './bridge';
import type { MemoryBridgeDeps, UniversalMemoryBridge } from './bridge';

/** Alias kept for readability at the integration site. */
export const createUniversalMemoryBridge = createMemoryBridge;

export type { MemoryBridgeDeps, UniversalMemoryBridge };
