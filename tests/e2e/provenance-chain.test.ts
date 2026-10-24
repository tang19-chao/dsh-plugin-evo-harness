/**
 * P6.1-A2: real provenance mount-chain end-to-end tests (F3-TEST closure).
 *
 * The PR3-era key tests fed provenance straight into adapter mount specs
 * (`registerPromptSegment({..., origin, guidance, role, allowAdvice})`), so the
 * review could delete the upstream provenance plumbing in eight-surfaces and
 * every test stayed green (docs/reports/p6-review-round3-pr3.md finding ①).
 *
 * This suite walks the REAL production chain instead, with no manual
 * ScopeRegistry registration of role/allowAdvice anywhere:
 *
 *   patch.origin + patch.guidance
 *     -> CordisSeamManager.runInIsolatedBranch / applyPermanentPatch
 *       -> mountEightSurfaces (resolves role/allowAdvice from provenance)
 *         -> adapter mount spec base (HostPromptSegmentSpec / HostGuardrailsSpec / ...)
 *           -> DshHookHostAdapter.register -> ScopeRegistry
 *             -> pre-step / pre-execute listeners (advisor gate)
 *             -> post-execute -> host-tool collector -> experience store
 *
 * The wiring mirrors src/index.ts: ONE ScopeRegistry instance shared by the
 * hook adapter and the host-tool experience collector; the structural fallback
 * host carries the non-hook seams exactly like the production adapter does.
 *
 * Only patch-level provenance decides the outcome; a mutation that removes the
 * origin/guidance/role/allowAdvice plumbing anywhere along this chain must
 * turn these tests red (mutation evidence recorded in the task delivery
 * notes, not as a script).
 *
 * D1 (ADR 0001) is load-bearing here: unprovable identities (anonymous
 * {name:'bash'}, sessionId-only, unregistered branches) degrade to pass-through
 * with no advice and no learning, so the contrast in scenarios 1-3 proves the
 * provenance chain itself - not a name heuristic - drives isolation.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createCordisSeamManager,
  createDshHookHostAdapter,
  createInMemoryCordisHost
} from '../../src/cordis-seams';
import type { DshHookHostAdapter, InMemoryCordisHost } from '../../src/cordis-seams';
import { createScopeRegistry } from '../../src/jitrl/scope-registry';
import type { HostAdvisor } from '../../src/jitrl/host-advisor';
import { createHostToolExperienceCollector } from '../../src/jitrl/host-tool-experience';
import { parseEvoHarnessConfig } from '../../src/config';
import type {
  EightSurfacePatch,
  ExperienceRecord,
  IExperienceStore,
  ProbeExecutionResult
} from '../../src/types/contracts';

// ---------------------------------------------------------------------------
// Real-chain fixtures: hook fixture + advisor + collector + seam manager
// ---------------------------------------------------------------------------

/** Minimal DSH hook context (same shape the unit fixtures use). */
function createProvenanceFixture(): {
  readonly ctx: Record<string, unknown>;
  listener(event: string): (...args: unknown[]) => unknown;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const remove = (event: string, listener: (...args: unknown[]) => unknown): void => {
    const entries = listeners.get(event);
    if (entries === undefined) {
      return;
    }
    const index = entries.indexOf(listener);
    if (index >= 0) {
      entries.splice(index, 1);
    }
  };
  const on = (event: string, listener: (...args: unknown[]) => unknown): (() => void) => {
    const current = listeners.get(event) ?? [];
    current.push(listener);
    listeners.set(event, current);
    return () => remove(event, listener);
  };
  const ctx: Record<string, unknown> = {
    on,
    off: remove,
    // One real DSH service so hook detection would succeed if probed.
    systemPrompt: { assemble: () => ({ sections: [] }) }
  };
  return {
    ctx,
    listener(event: string): (...args: unknown[]) => unknown {
      const entries = listeners.get(event);
      const listener = entries === undefined ? undefined : entries[0];
      if (listener === undefined) {
        throw new Error('no hook listener registered for "' + event + '"');
      }
      return listener;
    }
  };
}

function createMockAdvisor(evaluate: (request: unknown) => Promise<unknown>): HostAdvisor {
  return {
    evaluate: evaluate as unknown as HostAdvisor['evaluate'],
    diagnostics: () => []
  };
}

const JIT_CONFIG = parseEvoHarnessConfig({
  jitrl: {
    reward: { weights: { tool: 0.5, turn: 0.5, llm: 0, surrogate: 0, user: 0 }, clip: [-3, 3] }
  }
});

/** In-memory experience store capturing appended records. */
function memoryStore(): {
  readonly store: Pick<IExperienceStore, 'append'>;
  readonly records: ExperienceRecord[];
} {
  const records: ExperienceRecord[] = [];
  return {
    store: {
      append: async (batch: readonly ExperienceRecord[]): Promise<void> => {
        records.push(...batch);
      }
    },
    records
  };
}

interface ChainWiring {
  readonly adapter: DshHookHostAdapter;
  readonly fallback: InMemoryCordisHost;
  readonly seamManager: ReturnType<typeof createCordisSeamManager>;
  readonly records: ExperienceRecord[];
  readonly evaluate: ReturnType<typeof vi.fn>;
  preStep(payload: unknown, decision?: Record<string, unknown>): Promise<Record<string, unknown>>;
  preExecute(exec: unknown): Promise<Record<string, unknown>>;
  postExecute(exec: unknown, result: unknown): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
}

interface ChainOptions {
  /** Advice returned by the mock advisor for every evaluation. */
  readonly adviceText?: string;
}

/**
 * Build the real production mount chain with the D1 production-default wiring:
 * one ScopeRegistry shared by adapter and collector (as src/index.ts does), the
 * real collector, and the seam manager mounting patches through the adapter.
 * NO test code registers scopes by hand - provenance flows from the patch.
 */
function buildRealChain(options: ChainOptions = {}): ChainWiring {
  const fixture = createProvenanceFixture();
  const adviceText = options.adviceText ?? 'CHAIN_ADVICE_MARKER';
  const evaluate = vi.fn().mockResolvedValue({ kind: 'advisory', text: adviceText });
  const { store, records } = memoryStore();
  const scopeRegistry = createScopeRegistry();
  const collector = createHostToolExperienceCollector({
    config: JIT_CONFIG,
    store,
    scopeRegistry
  });
  const fallback = createInMemoryCordisHost();

  const adapter = createDshHookHostAdapter(fixture.ctx, {
    hostAdvisor: createMockAdvisor(evaluate),
    hostAdvisorMode: 'advisory',
    hostToolExperience: collector,
    scopeRegistry,
    fallback
  });
  adapter.install();

  const seamManager = createCordisSeamManager({
    host: adapter,
    namespacePrefix: 'harness2',
    now: () => 1_700_000_000_000
  });

  const postExecute = fixture.listener('tools/post-execute') as unknown as (
    exec: unknown,
    result: unknown,
    next: unknown
  ) => Promise<unknown>;
  const acceptNext = async (): Promise<{ kind: string }> => ({ kind: 'accept' });

  return {
    adapter,
    fallback,
    seamManager,
    records,
    evaluate,
    async preStep(
      payload,
      decision = { kind: 'enter', messages: [] }
    ): Promise<Record<string, unknown>> {
      const listener = fixture.listener('agent/pre-step') as unknown as (
        p: unknown,
        next: unknown
      ) => Promise<unknown>;
      return (await Promise.resolve(
        listener(payload, () => Promise.resolve(decision))
      )) as Record<string, unknown>;
    },
    async preExecute(exec: unknown): Promise<Record<string, unknown>> {
      const listener = fixture.listener('tools/pre-execute') as unknown as (
        e: unknown,
        next: unknown
      ) => Promise<unknown>;
      return (await Promise.resolve(
        listener(exec, async (): Promise<Record<string, unknown>> => ({ kind: 'allow' }))
      )) as Record<string, unknown>;
    },
    async postExecute(exec: unknown, result: unknown): Promise<Record<string, unknown>> {
      return (await postExecute(exec, result, acceptNext)) as Record<string, unknown>;
    },
    async dispose(): Promise<void> {
      await seamManager.dispose();
      collector.dispose();
      await adapter.dispose();
    }
  };
}

/** A one-surface system_prompt patch with controllable provenance. */
function provenancePatch(overrides: {
  readonly id: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly origin: EightSurfacePatch['origin'];
  readonly guidance: EightSurfacePatch['guidance'];
  readonly content?: string;
}): EightSurfacePatch {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId,
    branchId: overrides.branchId,
    origin: overrides.origin,
    purpose: 'explore',
    guidance: overrides.guidance,
    label: overrides.id,
    rationale: 'provenance-chain probe ' + overrides.id,
    edits: {
      system_prompt: {
        kind: 'system_prompt',
        mode: 'append',
        content: overrides.content ?? 'provenance probe segment'
      }
    },
    createdAt: 1_700_000_000_000
  };
}

/** Registry branchId the seam manager derives for a permanent patch. */
function permanentBranchId(patchId: string): string {
  return 'permanent-' + patchId;
}

// ---------------------------------------------------------------------------
// The real mount chain end-to-end (provenance decides, never the test author)
// ---------------------------------------------------------------------------

describe('P6.1-A2: real provenance mount chain (patch -> seam-manager -> adapter -> registry -> advisor/collector)', () => {
  it('scenario 1: neutral branch name + invariant provenance gets no advice and no memory sample, execution passes through', async () => {
    const chain = buildRealChain();
    try {
      const sessionId = 'sess-chain-1';
      // Neutral name: no 'inv' prefix, an '-s1' slot suffix that is NOT a
      // recognized invariant marker. Only the provenance can isolate it.
      const branchId = sessionId + '::tree-1::r1-s1';

      let registryDuringRun:
        | { readonly isInvariant: boolean; readonly allowAdvice: boolean; readonly guidance: string }
        | undefined;
      let adviceDuringRun: readonly string[] | undefined;
      let executedDuringRun: Record<string, unknown> | undefined;
      let recordsDuringRun = -1;

      const trajectory = await chain.seamManager.runInIsolatedBranch({
        sessionId,
        task: { id: 'task-inv', prompt: 'probe invariant isolation' },
        patch: provenancePatch({
          id: 'patch-inv',
          sessionId,
          branchId,
          origin: 'invariant',
          guidance: 'guidance_free'
        }),
        branchId,
        role: 'candidate',
        executor: async (): Promise<ProbeExecutionResult> => {
          // Provenance reached the registry through the real mount chain only.
          const scope = chain.adapter.scopeRegistry?.get(branchId);
          registryDuringRun = scope
            ? {
                isInvariant: scope.isInvariant,
                allowAdvice: scope.allowAdvice,
                guidance: scope.guidance
              }
            : undefined;

          const step = await chain.preStep({ branchId, sessionId });
          adviceDuringRun = Array.isArray(step['additionalContexts'])
            ? (step['additionalContexts'] as readonly string[])
            : undefined;

          executedDuringRun = await chain.preExecute({ name: 'bash', branchId, sessionId });

          recordsDuringRun = chain.records.length;
          await chain.postExecute(
            { name: 'bash', branchId, sessionId },
            { isError: false, exitCode: 0 }
          );
          return {
            status: 'succeeded',
            deliverable: { content: 'ok', format: 'markdown' }
          };
        }
      });
      expect(trajectory.status).toBe('succeeded');

      // Registry verdict came from provenance: invariant, advice-free.
      expect(registryDuringRun).toBeDefined();
      expect(registryDuringRun?.isInvariant).toBe(true);
      expect(registryDuringRun?.allowAdvice).toBe(false);
      expect(registryDuringRun?.guidance).toBe('guidance_free');

      // No advice reached the pre-step while the invariant mount was live.
      expect(adviceDuringRun).toBeUndefined();
      expect(chain.evaluate).not.toHaveBeenCalled();

      // Ordinary tool execution passed through untouched (D1: no extra deny).
      expect(executedDuringRun).toEqual({ kind: 'allow' });

      // The tool result inside the invariant scope produced zero learnable rows.
      expect(chain.records.length).toBe(recordsDuringRun);

      // Branch teardown removed the mount and the registry entry: no residue.
      expect(chain.adapter.scopeRegistry?.get(branchId)).toBeUndefined();
      expect(chain.adapter.activeMounts()).toHaveLength(0);
    } finally {
      await chain.dispose();
    }
  });

  it('scenario 2: the same branchId flips with provenance - invariant phase gets nothing, domain phase gets advice and correctly-attributed experience, with full dispose between', async () => {
    const chain = buildRealChain();
    try {
      const sessionId = 'sess-chain-2';
      const branchId = sessionId + '::tree-1::r1-s3';

      // Phase A: invariant provenance on the branch.
      const phaseA = await chain.seamManager.runInIsolatedBranch({
        sessionId,
        task: { id: 'task-flip-a', prompt: 'probe invariant phase' },
        patch: provenancePatch({
          id: 'patch-flip-inv',
          sessionId,
          branchId,
          origin: 'invariant',
          guidance: 'guidance_free'
        }),
        branchId,
        role: 'candidate',
        executor: async (): Promise<ProbeExecutionResult> => {
          const scope = chain.adapter.scopeRegistry?.get(branchId);
          expect(scope).toBeDefined();
          expect(scope?.isInvariant).toBe(true);
          expect(scope?.allowAdvice).toBe(false);
          expect(scope?.guidance).toBe('guidance_free');

          const step = await chain.preStep({ branchId, sessionId });
          expect(step['additionalContexts']).toBeUndefined();
          expect(chain.evaluate).not.toHaveBeenCalled();

          const before = chain.records.length;
          await chain.postExecute(
            { name: 'bash', branchId, sessionId },
            { isError: false, exitCode: 0 }
          );
          expect(chain.records.length).toBe(before);
          return { status: 'succeeded', deliverable: { content: 'ok', format: 'markdown' } };
        }
      });
      // Executor assertions are real: a failed phase A must fail the test, not
      // be swallowed by the branch error boundary.
      expect(phaseA.status).toBe('succeeded');

      // Full dispose between the two mountings: nothing survives phase A.
      expect(chain.adapter.scopeRegistry?.get(branchId)).toBeUndefined();
      expect(chain.adapter.activeMounts()).toHaveLength(0);

      // Phase B: the SAME branchId, domain provenance.
      const phaseB = await chain.seamManager.runInIsolatedBranch({
        sessionId,
        task: { id: 'task-flip-b', prompt: 'probe domain phase' },
        patch: provenancePatch({
          id: 'patch-flip-dom',
          sessionId,
          branchId,
          origin: 'domain',
          guidance: 'memory'
        }),
        branchId,
        role: 'candidate',
        executor: async (): Promise<ProbeExecutionResult> => {
          const scope = chain.adapter.scopeRegistry?.get(branchId);
          expect(scope).toBeDefined();
          expect(scope?.isInvariant).toBe(false);
          expect(scope?.allowAdvice).toBe(true);
          expect(scope?.guidance).toBe('memory');

          chain.evaluate.mockClear();
          const step = await chain.preStep({ branchId, sessionId });
          expect(chain.evaluate).toHaveBeenCalledTimes(1);
          expect(step['additionalContexts']).toEqual(['CHAIN_ADVICE_MARKER']);
          expect(chain.adapter.hostAdvisorStats().advisory).toBe(1);

          // Tool experience inside the trusted domain scope: learned AND
          // attributed to this branch (no 'unknown' bucket, exact identity).
          await chain.postExecute(
            { name: 'bash', branchId, sessionId },
            { isError: false, exitCode: 0 }
          );
          const learned = chain.records.filter((record) => record.actionKey === 'tool:bash');
          expect(learned).toHaveLength(1);
          expect(learned[0]?.guidance).toBe('memory');
          expect(learned[0]?.sessionId).toBe(sessionId);
          expect(learned[0]?.branchId).toBe(branchId);
          expect(learned[0]?.scopeKey).toBe(sessionId + '::' + branchId);
          return { status: 'succeeded', deliverable: { content: 'ok', format: 'markdown' } };
        }
      });
      expect(phaseB.status).toBe('succeeded');

      // After the domain phase ends, the same dispatch degrades again (D1 row 3).
      chain.evaluate.mockClear();
      const afterStep = await chain.preStep({ branchId, sessionId });
      expect(afterStep['additionalContexts']).toBeUndefined();
      expect(chain.evaluate).not.toHaveBeenCalled();
    } finally {
      await chain.dispose();
    }
  });

  it('scenario 3: -s2 and neutral-named domain branches are NOT falsely isolated; the name heuristic never grants or denies by itself', async () => {
    const chain = buildRealChain();
    try {
      const sessionId = 'sess-chain-3';
      const s2Branch = sessionId + '::tree-1::r0-s2';
      const s1Branch = sessionId + '::tree-1::r0-s1';

      const s2Disposer = await chain.seamManager.applyPermanentPatch(
        provenancePatch({
          id: 'patch-s2',
          sessionId,
          branchId: s2Branch,
          origin: 'domain',
          guidance: 'memory'
        })
      );
      const s1Disposer = await chain.seamManager.applyPermanentPatch(
        provenancePatch({
          id: 'patch-s1',
          sessionId,
          branchId: s1Branch,
          origin: 'domain',
          guidance: 'memory'
        })
      );

      // applyPermanentPatch registers under the derived permanent branch id.
      const s2Key = permanentBranchId('patch-s2');
      const s2Scope = chain.adapter.scopeRegistry?.get(s2Key);
      expect(s2Scope).toBeDefined();
      expect(s2Scope?.isInvariant).toBe(false);
      expect(s2Scope?.allowAdvice).toBe(true);
      expect(s2Scope?.guidance).toBe('memory');

      chain.evaluate.mockClear();
      const s2Step = await chain.preStep({ branchId: s2Key, sessionId });
      expect(s2Step['additionalContexts']).toEqual(['CHAIN_ADVICE_MARKER']);
      const s1Key = permanentBranchId('patch-s1');
      const s1Step = await chain.preStep({ branchId: s1Key, sessionId });
      expect(s1Step['additionalContexts']).toEqual(['CHAIN_ADVICE_MARKER']);
      expect(chain.evaluate).toHaveBeenCalledTimes(2);

      await s2Disposer.dispose();
      await s1Disposer.dispose();
      expect(chain.adapter.scopeRegistry?.get(s2Key)).toBeUndefined();
      expect(chain.adapter.scopeRegistry?.get(s1Key)).toBeUndefined();
    } finally {
      await chain.dispose();
    }
  });

  it('scenario 4: unregistered branch, anonymous {name:bash} and sessionId-only dispatches degrade per D1 while execution passes through', async () => {
    const chain = buildRealChain();
    try {
      // 1) Unregistered branch: no patch mount ever created it.
      const unregistered = await chain.preStep({
        branchId: 'no-patch-ever-created-this',
        sessionId: 'sess-chain-4'
      });
      expect(chain.evaluate).not.toHaveBeenCalled();
      expect(unregistered['additionalContexts']).toBeUndefined();

      const unregisteredExec = await chain.preExecute({
        name: 'bash',
        branchId: 'no-patch-ever-created-this',
        sessionId: 'sess-chain-4'
      });
      expect(unregisteredExec).toEqual({ kind: 'allow' });

      // Unregistered branch tool result: no learning.
      const beforeUnregistered = chain.records.length;
      await chain.postExecute(
        { name: 'bash', branchId: 'no-patch-ever-created-this', sessionId: 'sess-chain-4' },
        { isError: false }
      );
      expect(chain.records.length).toBe(beforeUnregistered);

      // 2) Anonymous dispatch: only a tool name, no identity at all.
      chain.evaluate.mockClear();
      const anonymous = await chain.preStep({});
      expect(chain.evaluate).not.toHaveBeenCalled();
      expect(anonymous['additionalContexts']).toBeUndefined();
      // unregistered preStep + anonymous preStep both counted, payload free.
      expect(chain.adapter.hostAdvisorStats().scopeUnknownSkipped).toBe(2);

      const anonymousExec = await chain.preExecute({ name: 'bash' });
      expect(anonymousExec).toEqual({ kind: 'allow' });

      const beforeAnonymous = chain.records.length;
      await chain.postExecute({ name: 'bash' }, { isError: false, exitCode: 0 });
      expect(chain.records.length).toBe(beforeAnonymous);

      // 3) sessionId-only dispatch (D1 contract row 5).
      const sessionOnly = await chain.preStep({ sessionId: 'sess-chain-4-only' });
      expect(sessionOnly['additionalContexts']).toBeUndefined();
      expect(chain.adapter.hostAdvisorStats().scopeUnknownSkipped).toBe(3);

      const sessionOnlyExec = await chain.preExecute({
        name: 'bash',
        sessionId: 'sess-chain-4-only'
      });
      expect(sessionOnlyExec).toEqual({ kind: 'allow' });

      // 4) A payload self-claiming invariant/memory flags without any mount
      //    stays unproven: payload flags are never promoted to authorization.
      const rogue = await chain.preStep({
        branchId: 'rogue-self-claimed',
        sessionId: 'sess-chain-4',
        role: 'invariant',
        allowAdvice: false
      });
      expect(chain.evaluate).not.toHaveBeenCalled();
      expect(rogue['additionalContexts']).toBeUndefined();
      const beforeRogue = chain.records.length;
      await chain.postExecute(
        {
          name: 'bash',
          branchId: 'rogue-self-claimed',
          sessionId: 'sess-chain-4',
          guidance: 'memory',
          origin: 'explore_domain'
        },
        { isError: false }
      );
      expect(chain.records.length).toBe(beforeRogue);
    } finally {
      await chain.dispose();
    }
  });

  it('scenario 5: multiple surfaces on one branch mount and release without cross-surface residue or scope bleed', async () => {
    const chain = buildRealChain();
    try {
      const sessionId = 'sess-chain-5';
      const patchId = 'patch-multi';
      const branchId = permanentBranchId(patchId);

      const patch: EightSurfacePatch = {
        id: patchId,
        sessionId,
        branchId,
        origin: 'domain',
        purpose: 'explore',
        guidance: 'memory',
        label: 'multi-surface',
        rationale: 'mount several surfaces through the real chain',
        edits: {
          system_prompt: {
            kind: 'system_prompt',
            mode: 'append',
            content: 'multi-surface prompt'
          },
          guardrails: {
            kind: 'guardrails',
            toolPreconditions: [{ toolName: 'shell', rule: 'deny destructive flags' }]
          },
          memory: {
            kind: 'memory',
            workingNotes: ['branch scratch'],
            recallTags: ['build']
          },
          skills: {
            kind: 'skills',
            skills: [{ name: 'chain-sop', markdown: '# SOP', description: 'mounted by chain' }]
          }
        },
        createdAt: 1_700_000_000_000
      };

      const disposer = await chain.seamManager.applyPermanentPatch(patch);
      const scope = chain.adapter.scopeRegistry?.get(branchId);
      expect(scope).toBeDefined();
      expect(scope?.allowAdvice).toBe(true);
      expect(scope?.guidance).toBe('memory');

      // The hook-surface mounts carry the provenance into the registry...
      const step = await chain.preStep({ branchId, sessionId });
      expect(step['additionalContexts']).toEqual(['CHAIN_ADVICE_MARKER']);
      // ... and the guardrails rule from the SAME chain is enforced.
      const denied = await chain.preExecute({ name: 'shell', branchId, sessionId });
      expect(denied).toMatchObject({ kind: 'deny' });
      expect(String(denied['reason'])).toContain('destructive flags');

      // Non-hook surfaces (memory, skills) went through the shared mount base
      // with the same provenance fields attached to their specs.
      const namespace = 'harness2:probe_' + branchId;
      const memoryEffect = chain.fallback
        .effectsFor(namespace)
        .find((effect) => effect.surface === 'memory');
      expect(memoryEffect).toBeDefined();
      const memorySpec = memoryEffect?.spec as Record<string, unknown>;
      expect(memorySpec['origin']).toBe('domain');
      expect(memorySpec['guidance']).toBe('memory');
      expect(memorySpec['role']).toBe('domain');
      expect(memorySpec['allowAdvice']).toBe(true);
      const skillsEffect = chain.fallback
        .effectsFor(namespace)
        .find((effect) => effect.surface === 'skills');
      expect(skillsEffect).toBeDefined();
      const skillsSpec = skillsEffect?.spec as Record<string, unknown>;
      expect(skillsSpec['origin']).toBe('domain');
      expect(skillsSpec['allowAdvice']).toBe(true);

      // Dispose: prompt advice AND guardrails rules must both stop (no residue).
      await disposer.dispose();
      expect(chain.adapter.scopeRegistry?.get(branchId)).toBeUndefined();
      chain.evaluate.mockClear();
      const stepAfter = await chain.preStep({ branchId, sessionId });
      expect(stepAfter['additionalContexts']).toBeUndefined();
      expect(chain.evaluate).not.toHaveBeenCalled();
      const allowedAfter = await chain.preExecute({ name: 'shell', branchId, sessionId });
      expect(allowedAfter).toEqual({ kind: 'allow' });
      expect(chain.adapter.activeMounts()).toHaveLength(0);
      expect(chain.fallback.activeEffects()).toHaveLength(0);

      // A sibling branch never sees this branch's mounts (no cross-scope bleed).
      const sibling = await chain.preStep({
        branchId: sessionId + '::tree-1::r9-s9',
        sessionId
      });
      expect(sibling['additionalContexts']).toBeUndefined();
    } finally {
      await chain.dispose();
    }
  });

  it('scenario 6: a non-prompt surface (guardrails) carries provenance through the shared mount base into the registry and the advisor gate', async () => {
    const chain = buildRealChain({ adviceText: 'GUARDRAILS_CHAIN_ADVICE' });
    try {
      const sessionId = 'sess-chain-6';
      const domainPatchId = 'patch-guardrails-only';
      const domainKey = permanentBranchId(domainPatchId);

      // ONLY a guardrails edit: provenance must still reach the registry through
      // the common HostSurfaceSpecBase that every mount spec extends.
      const guardrailsOnlyPatch: EightSurfacePatch = {
        ...provenancePatch({
          id: domainPatchId,
          sessionId,
          branchId: domainKey,
          origin: 'domain',
          guidance: 'memory',
          content: ''
        }),
        edits: {
          guardrails: {
            kind: 'guardrails',
            appendRules: ['always cite evidence']
          }
        }
      };

      const disposer = await chain.seamManager.applyPermanentPatch(guardrailsOnlyPatch);
      const scope = chain.adapter.scopeRegistry?.get(domainKey);
      expect(scope).toBeDefined();
      expect(scope?.guidance).toBe('memory');
      expect(scope?.allowAdvice).toBe(true);
      expect(scope?.role).toBe('domain');

      const step = await chain.preStep({ branchId: domainKey, sessionId });
      expect(step['additionalContexts']).toEqual(['GUARDRAILS_CHAIN_ADVICE']);

      // Invariant provenance on a guardrails-only patch: same chain, opposite
      // verdict - the common base plumbing drives isolation, not the surface.
      const invPatchId = 'patch-guardrails-inv';
      const invKey = permanentBranchId(invPatchId);
      const invDisposer = await chain.seamManager.applyPermanentPatch({
        ...guardrailsOnlyPatch,
        id: invPatchId,
        branchId: invKey,
        origin: 'invariant',
        guidance: 'guidance_free'
      });
      const invScope = chain.adapter.scopeRegistry?.get(invKey);
      expect(invScope).toBeDefined();
      expect(invScope?.isInvariant).toBe(true);
      expect(invScope?.allowAdvice).toBe(false);
      expect(invScope?.guidance).toBe('guidance_free');

      chain.evaluate.mockClear();
      const invStep = await chain.preStep({ branchId: invKey, sessionId });
      expect(invStep['additionalContexts']).toBeUndefined();
      expect(chain.evaluate).not.toHaveBeenCalled();

      // No memory sample may be learned inside the guardrails-only invariant scope.
      const before = chain.records.length;
      await chain.postExecute(
        { name: 'bash', branchId: invKey, sessionId },
        { isError: false, exitCode: 0 }
      );
      expect(chain.records.length).toBe(before);

      await invDisposer.dispose();
      await disposer.dispose();
      expect(chain.adapter.scopeRegistry?.get(invKey)).toBeUndefined();
      expect(chain.adapter.scopeRegistry?.get(domainKey)).toBeUndefined();
    } finally {
      await chain.dispose();
    }
  });
});
