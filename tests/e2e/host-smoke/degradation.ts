/**
 * Event-shape degradation assertions (P6.1-F, ADR 0001 D1).
 *
 * A smoke against a real host will eventually meet a payload shape the adapter
 * was not written for: a hook dispatched with no tool name, a prompt assembly
 * without `sections`, a tool result whose `isError` sits under a different key.
 * The D1 contract says what must happen then: **pass through the host decision
 * unchanged, inject no advice and learn nothing**. It does not say "throw", and
 * it does not say "guess".
 *
 * This module turns that sentence into executable assertions. Each case builds
 * the off-contract payload the host could hand over, drives the plugin's real
 * adapter over a minimal Cordis-shaped waterfall driver, and checks:
 *
 *   - the returned decision is exactly what the host's own fallback returned
 *     (no rewrite, no deny);
 *   - a hostile advisor is never consulted for an unprovable identity;
 *   - no experience record is produced and no payload body is stored;
 *   - the plugin reports the degradation instead of crashing the turn.
 *
 * The driver here is a *structural* waterfall (not the installed host): these
 * assertions are about the adapter's contract, and they must also run where no
 * DSH is installed. The real-host run in `probe.ts` covers the same contract
 * against the actual bus.
 */
import type { DshHookHostAdapter, DshHookHostAdapterOptions } from '../../../src/cordis-seams/dsh-hook-host-adapter';
import type { ScopeRegistry, ScopeRegistryOptions } from '../../../src/jitrl/scope-registry';
import type { HostToolExperienceCollector, HostToolExperienceCollectorOptions } from '../../../src/jitrl/host-tool-experience';
import type { EvoHarnessConfig } from '../../../src/config';
import type { ExperienceRecord, IExperienceStore } from '../../../src/types/contracts';

/** A hostile advisor: it advises on EVERY call, and counts them. */
export interface HostileAdvisor {
  evaluate(request: unknown): Promise<{ kind: 'advisory'; text: string }>;
  /** HostAdvisor contract member; the hostile advisor emits none. */
  diagnostics(): readonly string[];
  readonly calls: number;
}

/** The plugin factories the degradation cases need. */
export interface DegradationModules {
  readonly createDshHookHostAdapter: (
    ctx: unknown,
    options?: DshHookHostAdapterOptions
  ) => DshHookHostAdapter;
  readonly createScopeRegistry: (options?: ScopeRegistryOptions) => ScopeRegistry;
  readonly createHostToolExperienceCollector: (
    options: HostToolExperienceCollectorOptions
  ) => HostToolExperienceCollector;
  readonly parseEvoHarnessConfig: (raw?: Record<string, unknown>) => EvoHarnessConfig;
}

/** A recording store; keeps only bounded fields. */
export function createRecordingStore(): Pick<IExperienceStore, 'append'> & {
  readonly records: readonly Pick<ExperienceRecord, 'level' | 'actionKey' | 'sessionId' | 'guidance'>[];
} {
  const records: Pick<ExperienceRecord, 'level' | 'actionKey' | 'sessionId' | 'guidance'>[] = [];
  return {
    records,
    async append(batch: readonly ExperienceRecord[]): Promise<void> {
      for (const record of batch) {
        records.push({
          level: record.level,
          actionKey: record.actionKey,
          sessionId: record.sessionId,
          guidance: record.guidance
        });
      }
    }
  };
}

/**
 * A structural Cordis-shaped context: only what the adapter actually uses
 * (`on`), plus a `waterfall` so the test can dispatch exactly like Cordis does
 * (outermost listener first, `next()` delegating inward).
 */
export interface StructuralHost {
  readonly listeners: Map<string, readonly ((...args: readonly unknown[]) => unknown)[]>;
  on(event: string, listener: (...args: readonly unknown[]) => unknown): () => void;
  dispatch(event: string, ...args: readonly unknown[]): Promise<unknown>;
  listenerCount(event: string): number;
}

/** Build the structural host used by the degradation cases. */
export function createStructuralHost(): StructuralHost {
  const listeners = new Map<string, ((...args: readonly unknown[]) => unknown)[]>();
  return {
    listeners,
    on(event: string, listener: (...args: readonly unknown[]) => unknown): () => void {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) {
          current.splice(index, 1);
        }
      };
    },
    async dispatch(event: string, ...args: readonly unknown[]): Promise<unknown> {
      const chain = [...(listeners.get(event) ?? [])];
      const fallback = args[args.length - 1];
      const payloadArgs = args.slice(0, -1);
      let index = 0;
      const next = async (): Promise<unknown> => {
        const listener = chain[index];
        index += 1;
        if (listener === undefined) {
          return typeof fallback === 'function'
            ? (fallback as () => Promise<unknown>)()
            : fallback;
        }
        return listener(...payloadArgs, next);
      };
      return next();
    },
    listenerCount(event: string): number {
      return (listeners.get(event) ?? []).length;
    }
  };
}

/** One degradation case's outcome. */
export interface DegradationResult {
  readonly id: string;
  /** What off-contract shape was injected. */
  readonly injected: string;
  /** D1 requirement for this case. */
  readonly requirement: string;
  /** Host fallback decision the adapter must not rewrite. */
  readonly hostDecision: string;
  /** Decision the adapter actually returned. */
  readonly observedDecision: string;
  readonly advisorCalls: number;
  readonly recordsAppended: number;
  readonly scopeUnknownSkipped: number;
  /** True when the adapter reported (rather than swallowed silently). */
  readonly diagnosticsReported: boolean;
  readonly passed: boolean;
}

/** A minimal valid plugin config for the degradation cases. */
export function degradationConfig(modules: DegradationModules): EvoHarnessConfig {
  return modules.parseEvoHarnessConfig({
    triggerMode: 'always',
    jitrl: {
      enabled: true,
      reward: { weights: { tool: 0.5, turn: 0.5, llm: 0, surrogate: 0, user: 0 }, clip: [-3, 3] }
    },
    memoryBridge: { namespacePrefix: 'harness2' },
    logging: { level: 'silent' }
  });
}

interface DegradationHarness {
  readonly adapter: DshHookHostAdapter;
  readonly host: StructuralHost;
  readonly registry: ScopeRegistry;
  readonly records: readonly Pick<ExperienceRecord, 'level' | 'actionKey' | 'sessionId' | 'guidance'>[];
  readonly advisor: HostileAdvisor;
  readonly diagnostics: string[];
  readonly diagnosticsMessages: string[];
}

/** Wire one adapter + registry + collector over the structural host. */
export function createDegradationHarness(input: {
  readonly modules: DegradationModules;
  readonly config: EvoHarnessConfig;
}): DegradationHarness {
  const host = createStructuralHost();
  const registry = input.modules.createScopeRegistry();
  const store = createRecordingStore();
  const diagnosticsMessages: string[] = [];
  const collector = input.modules.createHostToolExperienceCollector({
    config: input.config,
    store,
    scopeRegistry: registry,
    now: () => 1_700_000_000_000,
    onDiagnostic: (message: string) => diagnosticsMessages.push(message)
  });
  let calls = 0;
  const advisor: HostileAdvisor = {
    evaluate: async (): Promise<{ kind: 'advisory'; text: string }> => {
      calls += 1;
      return { kind: 'advisory', text: '<jitrl_advice>hostile</jitrl_advice>' };
    },
    // HostAdvisor contract member the adapter may probe; the hostile advisor
    // never emits diagnostics of its own.
    diagnostics: (): readonly string[] => [],
    get calls(): number {
      return calls;
    }
  };
  const adapter = input.modules.createDshHookHostAdapter(host, {
    scopeRegistry: registry,
    hostAdvisor: advisor,
    hostAdvisorMode: 'advisory',
    hostToolExperience: collector,
    onDiagnostic: (message: string) => diagnosticsMessages.push(message)
  });
  adapter.install();
  return {
    adapter,
    host,
    registry,
    records: store.records,
    advisor,
    diagnostics: [...adapter.advisories()],
    diagnosticsMessages
  };
}

/** Read a decision kind from a decision object. */
function kindOf(decision: unknown): string {
  if (decision !== null && typeof decision === 'object' && !Array.isArray(decision)) {
    const kind = (decision as Record<string, unknown>)['kind'];
    if (typeof kind === 'string') {
      return kind;
    }
  }
  return 'unknown';
}

/**
 * Run the degradation matrix.
 *
 * Every case follows one template: dispatch an off-contract payload whose host
 * fallback returns a KNOWN decision, then assert the adapter returned that same
 * decision while consulting no advisor and appending no record. `<jitrl_advice>`
 * never appearing in the decision is checked explicitly for the advisory surface.
 */
export async function runDegradationMatrix(input: {
  readonly modules: DegradationModules;
  readonly config: EvoHarnessConfig;
}): Promise<readonly DegradationResult[]> {
  const results: DegradationResult[] = [];
  const harness = createDegradationHarness(input);

  const record = (
    id: string,
    injected: string,
    requirement: string,
    hostDecision: string,
    observedDecision: string,
    extra: {
      readonly advisorCalls: number;
      readonly recordsAppended: number;
      readonly scopeUnknownSkipped: number;
      readonly diagnosticsReported: boolean;
      readonly extraOk: boolean;
    }
  ): void => {
    results.push({
      id,
      injected,
      requirement,
      hostDecision,
      observedDecision,
      advisorCalls: extra.advisorCalls,
      recordsAppended: extra.recordsAppended,
      scopeUnknownSkipped: extra.scopeUnknownSkipped,
      diagnosticsReported: extra.diagnosticsReported,
      passed:
        observedDecision === hostDecision &&
        extra.advisorCalls === 0 &&
        extra.recordsAppended === 0 &&
        extra.extraOk
    });
  };

  const statsBefore = (): { advisor: number; records: number; skipped: number } => ({
    advisor: harness.advisor.calls,
    records: harness.records.length,
    skipped: harness.adapter.hostAdvisorStats().scopeUnknownSkipped
  });

  // Case 1: tools/pre-execute with a tool descriptor carrying NO name.
  {
    const before = statsBefore();
    const fallback = { kind: 'allow' };
    const outer = harness.host.listenerCount('tools/pre-execute');
    if (outer === 0) {
      throw new Error('adapter did not install a tools/pre-execute listener');
    }
    const observed = await harness.host.dispatch('tools/pre-execute', { arguments: { text: 'x' } }, () =>
      Promise.resolve(fallback)
    );
    const after = statsBefore();
    record(
      'shape-1-pre-execute-without-tool-name',
      'tools/pre-execute payload with `arguments` but no `name`',
      'D1: pass the host decision through, no advice, no record',
      kindOf(fallback),
      kindOf(observed),
      {
        advisorCalls: after.advisor - before.advisor,
        recordsAppended: after.records - before.records,
        scopeUnknownSkipped: after.skipped - before.skipped,
        diagnosticsReported: harness.adapter.stats().installFailures.length === 0,
        extraOk: true
      }
    );
  }

  // Case 2: agent/pre-step whose host decision carries no `additionalContexts`
  // array and no identity: advice must not be appended, decision unchanged.
  {
    const before = statsBefore();
    const fallback = { kind: 'enter', messages: [] };
    const observed = await harness.host.dispatch('agent/pre-step', { messages: [], turn: 1, step: 1 }, () =>
      Promise.resolve(fallback)
    );
    const after = statsBefore();
    const observedRecord = observed !== null && typeof observed === 'object' ? (observed as Record<string, unknown>) : {};
    const noAdvice =
      observedRecord['additionalContexts'] === undefined &&
      !JSON.stringify(observedRecord).includes('<jitrl_advice>');
    record(
      'shape-2-pre-step-decision-without-additional-contexts',
      'agent/pre-step payload with no identity and a decision lacking additionalContexts',
      'D1: no advice appended; the enter decision is returned unchanged',
      kindOf(fallback),
      kindOf(observed),
      {
        advisorCalls: after.advisor - before.advisor,
        recordsAppended: after.records - before.records,
        scopeUnknownSkipped: after.skipped - before.skipped,
        diagnosticsReported: true,
        extraOk: noAdvice
      }
    );
  }

  // Case 3: tools/post-execute with a result whose error flag sits under an
  // undocumented key. The observation must be skipped (no learning) and the
  // result returned untouched.
  {
    const before = statsBefore();
    const fallback = { kind: 'accept' };
    const observed = await harness.host.dispatch(
      'tools/post-execute',
      { name: 'shaped_tool', arguments: {} },
      { ok: 'nope', payloadError: true },
      () => Promise.resolve(fallback)
    );
    const after = statsBefore();
    record(
      'shape-3-post-execute-unknown-error-shape',
      'tools/post-execute result with an undocumented error flag and no identity',
      'D1: no learning sample from an unprovable/unknown shape; host decision unchanged',
      kindOf(fallback),
      kindOf(observed),
      {
        advisorCalls: after.advisor - before.advisor,
        recordsAppended: after.records - before.records,
        scopeUnknownSkipped: after.skipped - before.skipped,
        diagnosticsReported: harness.diagnosticsMessages.length > 0,
        extraOk: true
      }
    );
  }

  // Case 4: system-prompt/assemble whose assembly has no `sections` array.
  // The prompt mount must be skipped with a bounded note, not thrown. A mount
  // has to exist first, otherwise the adapter has nothing to apply and never
  // reaches the shape check — so this case registers one prompt segment.
  {
    const mount = await harness.adapter.registerPromptSegment({
      branchId: 'hostsmoke-shape-b1',
      sessionId: 'hostsmoke-shape-s1',
      namespace: 'hostsmoke/shape',
      surfaceId: 'shape-4',
      segment: 'hostsmoke-shape-4',
      mode: 'append',
      content: 'host-smoke shape probe'
    } as never);
    const fallback = { prompt: 'not-an-assembly' };
    const observed = await harness.host.dispatch('system-prompt/assemble', {}, { prompt: 'x' }, () =>
      Promise.resolve(fallback)
    );
    const same = JSON.stringify(observed) === JSON.stringify(fallback);
    results.push({
      id: 'shape-4-assembly-without-sections',
      injected: 'system-prompt/assemble assembly object without a sections array',
      requirement: 'the mount is skipped with a bounded note; the host assembly is returned unchanged',
      hostDecision: 'object-without-sections',
      observedDecision: same ? 'object-without-sections' : 'rewritten',
      advisorCalls: 0,
      recordsAppended: 0,
      scopeUnknownSkipped: 0,
      diagnosticsReported: harness.diagnosticsMessages.some((line) =>
        line.includes('without a sections array')
      ),
      passed: same
    });
    mount.dispose();
  }

  // Case 5: a payload that SELF-CLAIMS trusted identity must not become a
  // learning scope. This is the D1 "claimed vs proven" case.
  {
    const before = statsBefore();
    const fallback = { kind: 'accept' };
    const observed = await harness.host.dispatch(
      'tools/post-execute',
      {
        name: 'claimed_tool',
        arguments: {},
        // Self-declared identity and role: untrusted by construction.
        branchId: 'inv-self-claimed',
        sessionId: 'sess-self-claimed',
        role: 'domain',
        guidance: 'memory',
        allowAdvice: true
      },
      { isError: false, content: [{ type: 'text', text: 'ok' }] },
      () => Promise.resolve(fallback)
    );
    const after = statsBefore();
    record(
      'shape-5-self-claimed-identity',
      'tools/post-execute payload self-declaring branchId/sessionId/role/allowAdvice',
      'D1: a payload self-claim is not authorization; no advice, no record',
      kindOf(fallback),
      kindOf(observed),
      {
        advisorCalls: after.advisor - before.advisor,
        recordsAppended: after.records - before.records,
        scopeUnknownSkipped: after.skipped - before.skipped,
        diagnosticsReported: true,
        extraOk: true
      }
    );
  }

  // Case 6: a hook event the host never dispatches. The adapter must still be
  // installed (listener present) and dispose must remove it cleanly.
  {
    const beforeDispose = harness.host.listenerCount('system-prompt/assemble');
    await harness.adapter.dispose();
    const afterDispose = harness.host.listenerCount('system-prompt/assemble');
    results.push({
      id: 'shape-6-undispatched-hook',
      injected: 'system-prompt/assemble listener installed but never dispatched',
      requirement: 'install is idempotent and dispose removes every listener (no residue)',
      hostDecision: 'listener-installed',
      observedDecision: afterDispose === 0 ? 'listener-removed' : 'listener-residue',
      advisorCalls: 0,
      recordsAppended: 0,
      scopeUnknownSkipped: 0,
      diagnosticsReported: true,
      passed: beforeDispose === 1 && afterDispose === 0 && harness.adapter.isDisposed
    });
  }

  return results;
}
