/**
 * Shared deterministic fixtures for the memory-bridge unit tests. The config is
 * always produced by the frozen resolveEvoHarnessConfig so tests exercise the
 * real schema instead of a hand-written object.
 */

import { resolveEvoHarnessConfig } from '../../../src/config';
import type { MemoryBridgeConfig } from '../../../src/config';
import type { CanonicalLesson, MemoryScope } from '../../../src/types/contracts';

export const FIXED_NOW = 1_700_000_000_000;

export const SESSION = 's-1';
export const BRANCH_A = 'b-1';
export const BRANCH_B = 'b-2';

export const BRANCH_A_NS = 'harness2:branch:s-1:b-1';
export const BRANCH_B_NS = 'harness2:branch:s-1:b-2';
export const GLOBAL_NS = 'harness2:global';

export type MemoryConfigOverrides = {
  [K in keyof MemoryBridgeConfig]?: MemoryBridgeConfig[K];
};

/** Frozen memoryBridge config with optional overrides. */
export function memoryConfig(overrides: MemoryConfigOverrides = {}): MemoryBridgeConfig {
  return resolveEvoHarnessConfig({ memoryBridge: overrides }).memoryBridge;
}

export function branchScope(sessionId: string = SESSION, branchId: string = BRANCH_A): MemoryScope {
  return { kind: 'branch', sessionId, branchId };
}

export function sessionScope(sessionId: string = SESSION): MemoryScope {
  return { kind: 'session', sessionId };
}

export const GLOBAL_SCOPE: MemoryScope = { kind: 'global' };

/** A complete, governance-clean CCG lesson. */
export function validLesson(overrides: Partial<CanonicalLesson> = {}): CanonicalLesson {
  return {
    id: 'L-1',
    title: 'Pin the failing tool signature before probing',
    whenToApply: ['a tool keeps failing argument validation'],
    subFunctions: ['guardrails', 'tool_guidance'],
    executionPatch: {
      summary: 'Add one worked example per failing tool signature.',
      componentDiffs: { tool_guidance: 'add example for the failing call' }
    },
    verificationEvidence: {
      referenceFailure: 'reference run: 3 argument-validation tool errors',
      candidateSuccess: 'candidate run: 0 argument-validation tool errors',
      metricsDelta: { stepsDiff: -4, toolErrorsDiff: -3 }
    },
    whenNotToApply: ['offline sandbox'],
    polarity: 'positive',
    visibility: 'branch_private',
    sessionId: SESSION,
    branchId: BRANCH_A,
    createdAt: FIXED_NOW,
    confidence: 0.9,
    ...overrides
  };
}

/** A negative (failure) lesson with the same required CCG shape. */
export function negativeLesson(overrides: Partial<CanonicalLesson> = {}): CanonicalLesson {
  return validLesson({
    id: 'L-neg',
    title: 'Do not inline the whole schema into the prompt',
    whenToApply: ['the tool schema is large'],
    executionPatch: { summary: 'Inlining the schema caused context overflow.' },
    verificationEvidence: {
      referenceFailure: 'reference run: no failure',
      candidateSuccess: 'candidate run: context overflow',
      metricsDelta: { stepsDiff: 0, toolErrorsDiff: 2 }
    },
    whenNotToApply: ['tiny schemas'],
    polarity: 'negative',
    confidence: 0.4,
    ...overrides
  });
}

/** Global-visibility variant used for promote/global tests. */
export function globalLesson(overrides: Partial<CanonicalLesson> = {}): CanonicalLesson {
  return validLesson({ visibility: 'global', branchId: undefined, ...overrides });
}
