/**
 * Hand-written types for `apply-context.mjs` (rev6 R2-1 / R2-2).
 *
 * The module is plain ESM (the in-host runner imports it inside the installed
 * DSH runtime, where no TypeScript loader exists), so the e2e tests need this
 * declaration file to typecheck. Same convention as `check-clean-tree.d.mts`.
 */

/** One surface's classification as reported by the harness classifier. */
export interface ApplyContextMatrixFace {
  surface: string;
  configured: boolean;
  availability: 'native' | 'fallback' | 'unavailable' | 'not-run';
  mechanism: string;
  hostMethod: string;
  seamPresent: boolean;
  evidence: string;
  limitation?: string;
}

/** The matrix the probe classifies over the apply context. */
export interface ApplyContextMatrix {
  capturedAt: string;
  hostAdapterSource: string;
  resolveHostAdapterSource?: string;
  hookDetected: boolean;
  installedHookEvents: readonly string[];
  structuralSeams: number;
  contextKind: 'bare-cordis-context' | 'not-run';
  faces: readonly ApplyContextMatrixFace[];
  problems: readonly string[];
}

/** The handle's own per-surface projection (production code). */
export interface ApplyContextSurfaceStatus {
  surface: string;
  enabled: boolean;
  mountable: boolean;
  hasLastMountResult: boolean;
  lastMountResult: { ok: boolean; code?: string } | null;
  hasSeamUnavailable: boolean;
  seamUnavailable: number | null;
  cacheRead: string | null;
}

/** Identity captured from one real dispatch. */
export interface ApplyContextIdentity {
  event: string;
  dispatched: boolean;
  branchIds: number;
  sessionIds: number;
  namespaces: number;
  fields: readonly string[];
  matched: boolean;
}

export interface ApplyContextResult {
  ok: boolean;
  applyContext: {
    contextKind: string;
    services: { tools: boolean; systemPrompt: boolean; commands: boolean };
    productionResolvedSource: string;
    detectDetected: boolean;
    structuralSeams: number;
    applyReturnedHandle: boolean;
    applyError: string | null;
  };
  hookRegistration: {
    registered: readonly string[];
    expected: readonly string[];
    missing: readonly string[];
    extra: readonly string[];
    matched: boolean;
  };
  identity: readonly ApplyContextIdentity[];
  surfaces: readonly ApplyContextSurfaceStatus[];
  classifiedAdapterSource: string | null;
  matrix: ApplyContextMatrix | null;
  crossCheck: {
    checked: number;
    disagreements: readonly string[];
    lastMountResultObserved: number;
    cacheReadUnknown: number;
    note: string;
  };
  dispose: { disposed: boolean; error: string | null };
  problems: readonly string[];
}

export interface ApplyContextJudgement {
  applyContextEvidence: boolean;
  surfaceEvidence: boolean;
  blocked: boolean;
  applyReasons: readonly string[];
  branchReasons: readonly string[];
}

/** Probe input: the host modules, the production symbols, and expectations. */
export interface ProbeApplyContextInput {
  host: {
    createContext: () => unknown;
    SystemPrompt: unknown;
    ToolRuntime: unknown;
  };
  plugin: Record<string, unknown>;
  config?: unknown;
  expectedHookEvents?: readonly string[];
}

export function probeApplyContext(input: ProbeApplyContextInput): Promise<ApplyContextResult>;

export function judgeApplyContext(probe: ApplyContextResult | undefined | null): ApplyContextJudgement;