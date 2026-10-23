/**
 * Host-tool experience producer tests (plan sections 4 R2, 5.2; PR3/R2+R3).
 *
 * Verifies:
 *   1. Appendix B sequence: A/B cross-session interleaved tool calls do not leak;
 *      turn end for session A credits A + read_alpha, without B's write_beta context.
 *   2. Same session, different branches: branch isolation ensures sibling probe branches
 *      do not share recent tools or credits.
 *   3. Out-of-order dispatches: turn/end arriving before tool calls does not falsely attribute.
 *   4. Duplicate turn/end: duplicate turn/end dispatches do not produce duplicate rewards;
 *      pending credit is cleaned up on turn termination.
 *   5. Turn/end without prior tool calls: nothing is appended.
 *   6. Aborted turns: reason.kind 'aborted' cleans up pending credit with 0 reward.
 *   7. Disable, re-enable and dispose: runtime gate stops/resumes collection; dispose clears states.
 *   8. Invariant probe protection: invariant probe scopes are rejected from writing memory records.
 *   9. Unknown scope isolation: unknown scopes never inherit or borrow global recent states.
 *  10. Bounded scope capacity and TTL pruning.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseEvoHarnessConfig } from '../../../src/config';
import type { ExperienceRecord, IExperienceStore } from '../../../src/types/contracts';
import {
  createHostToolExperienceCollector,
  HOST_TOOL_REWARD_SIGNALS,
  type HostToolObservation,
  type HostTurnObservation
} from '../../../src/jitrl/host-tool-experience';
import { createScopeRegistry } from '../../../src/jitrl/scope-registry';

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

const baseConfig = parseEvoHarnessConfig({
  jitrl: {
    enabled: true,
    reward: {
      weights: { tool: 0.5, turn: 0.5, llm: 0, surrogate: 0, user: 0 },
      clip: [-3, 3]
    }
  }
});

describe('R2: host-tool experience scope isolation and attribution', () => {
  it('reproduces and fixes Appendix B: A/B interleaved tool calls attribute correctly to A without B context', async () => {
    const { store, records } = memoryStore();
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store
    });

    // Appendix B minimal sequence:
    // 1. Session A / Branch A: read_alpha succeeds
    await collector.observeToolCall({
      toolName: 'read_alpha',
      isError: false,
      sessionId: 'A',
      branchId: 'branch-A',
      at: 1000
    });

    // 2. Session B / Branch B: write_beta succeeds
    await collector.observeToolCall({
      toolName: 'write_beta',
      isError: false,
      sessionId: 'B',
      branchId: 'branch-B',
      at: 1001
    });

    // 3. Session A / Branch A: turn completed
    await collector.observeTurnEnd({
      kind: 'completed',
      sessionId: 'A',
      branchId: 'branch-A',
      at: 1002
    });

    // Two tool calls + one turn end = 3 records total
    expect(records).toHaveLength(3);

    // Record 1: tool call read_alpha for session A
    expect(records[0]?.sessionId).toBe('A');
    expect(records[0]?.actionKey).toBe('tool:read_alpha');
    expect(records[0]?.state.tokens).toContain('tool:read_alpha');
    expect(records[0]?.state.tokens).not.toContain('tool:write_beta');

    // Record 2: tool call write_beta for session B
    expect(records[1]?.sessionId).toBe('B');
    expect(records[1]?.actionKey).toBe('tool:write_beta');
    expect(records[1]?.state.tokens).toContain('tool:write_beta');
    expect(records[1]?.state.tokens).not.toContain('tool:read_alpha');

    // Record 3: turn end for session A MUST attribute to A + read_alpha, NOT write_beta!
    const turnRecord = records[2]!;
    expect(turnRecord.sessionId).toBe('A');
    expect(turnRecord.actionKey).toBe('tool:read_alpha');
    expect(turnRecord.rewardSources['turn']).toBe(0.5 * HOST_TOOL_REWARD_SIGNALS.turnCompleted);

    // CRITICAL: Session A's state tokens must NEVER contain write_beta from session B
    expect(turnRecord.state.tokens).toContain('tool:read_alpha');
    expect(turnRecord.state.tokens).not.toContain('tool:write_beta');
  });

  it('isolates sibling branches in the same session', async () => {
    const { store, records } = memoryStore();
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store
    });

    // Same session 'sess-1', but different branches 'probe-1' and 'probe-2'
    await collector.observeToolCall({
      toolName: 'tool_one',
      isError: false,
      sessionId: 'sess-1',
      branchId: 'probe-1'
    });

    await collector.observeToolCall({
      toolName: 'tool_two',
      isError: false,
      sessionId: 'sess-1',
      branchId: 'probe-2'
    });

    // Turn end for probe-1 credits tool_one, not tool_two
    await collector.observeTurnEnd({
      kind: 'completed',
      sessionId: 'sess-1',
      branchId: 'probe-1'
    });

    expect(records).toHaveLength(3);
    const probe1Turn = records[2]!;
    expect(probe1Turn.branchId).toBe('probe-1');
    expect(probe1Turn.actionKey).toBe('tool:tool_one');
    expect(probe1Turn.state.tokens).toContain('tool:tool_one');
    expect(probe1Turn.state.tokens).not.toContain('tool:tool_two');

    // Turn end for probe-2 credits tool_two
    await collector.observeTurnEnd({
      kind: 'completed',
      sessionId: 'sess-1',
      branchId: 'probe-2'
    });

    expect(records).toHaveLength(4);
    const probe2Turn = records[3]!;
    expect(probe2Turn.branchId).toBe('probe-2');
    expect(probe2Turn.actionKey).toBe('tool:tool_two');
    expect(probe2Turn.state.tokens).toContain('tool:tool_two');
    expect(probe2Turn.state.tokens).not.toContain('tool:tool_one');
  });

  it('handles out-of-order events gracefully without false credits', async () => {
    const { store, records } = memoryStore();
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store
    });

    // turn/end arrives before any tool call
    await collector.observeTurnEnd({
      kind: 'completed',
      sessionId: 'sess-order',
      branchId: 'br-order'
    });

    // Nothing to credit: no record emitted
    expect(records).toHaveLength(0);

    // Now tool call arrives
    await collector.observeToolCall({
      toolName: 'delayed_tool',
      isError: false,
      sessionId: 'sess-order',
      branchId: 'br-order'
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.actionKey).toBe('tool:delayed_tool');
  });

  it('prevents duplicate turn/end attribution and cleans up pending credit', async () => {
    const { store, records } = memoryStore();
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store
    });

    await collector.observeToolCall({
      toolName: 'single_tool',
      isError: false,
      sessionId: 'sess-dup',
      branchId: 'br-dup'
    });

    // First turn/end: credits single_tool
    await collector.observeTurnEnd({
      kind: 'completed',
      sessionId: 'sess-dup',
      branchId: 'br-dup'
    });

    expect(records).toHaveLength(2);

    // Second (duplicate) turn/end for the same scope: pending credit is already consumed!
    await collector.observeTurnEnd({
      kind: 'completed',
      sessionId: 'sess-dup',
      branchId: 'br-dup'
    });

    // No extra record should be appended
    expect(records).toHaveLength(2);
  });

  it('ignores turn/end when no tool was ever called in that scope', async () => {
    const { store, records } = memoryStore();
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store
    });

    await collector.observeTurnEnd({
      kind: 'completed',
      sessionId: 'never-called',
      branchId: 'br-none'
    });

    expect(records).toHaveLength(0);
    expect(collector.count()).toBe(0);
  });

  it('cleans up pending credit on aborted turn without positive credit', async () => {
    const { store, records } = memoryStore();
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store
    });

    await collector.observeToolCall({
      toolName: 'cancelled_tool',
      isError: false,
      sessionId: 'sess-abort',
      branchId: 'br-abort'
    });

    expect(records).toHaveLength(1);

    // Turn is aborted: signal is 0, pending credit is cleared
    await collector.observeTurnEnd({
      kind: 'aborted',
      sessionId: 'sess-abort',
      branchId: 'br-abort'
    });

    // Aborted turn produces no turn record
    expect(records).toHaveLength(1);

    // Subsequent completed turn has no pending credit to attribute
    await collector.observeTurnEnd({
      kind: 'completed',
      sessionId: 'sess-abort',
      branchId: 'br-abort'
    });

    expect(records).toHaveLength(1);
  });

  it('respects runtime toggle isEnabled and cleans up completely on dispose', async () => {
    const { store, records } = memoryStore();
    let enabled = true;
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store,
      isEnabled: () => enabled
    });

    await collector.observeToolCall({
      toolName: 'tool_one',
      isError: false,
      sessionId: 'sess-toggle',
      branchId: 'br-toggle'
    });
    expect(records).toHaveLength(1);

    // Turn off collection via runtime gate
    enabled = false;
    await collector.observeToolCall({
      toolName: 'tool_two',
      isError: false,
      sessionId: 'sess-toggle',
      branchId: 'br-toggle'
    });
    await collector.observeTurnEnd({
      kind: 'completed',
      sessionId: 'sess-toggle',
      branchId: 'br-toggle'
    });
    expect(records).toHaveLength(1);

    // Re-enable collection
    enabled = true;
    await collector.observeToolCall({
      toolName: 'tool_three',
      isError: false,
      sessionId: 'sess-toggle',
      branchId: 'br-toggle'
    });
    expect(records).toHaveLength(2);

    // Dispose collector: cleans all buckets and rejects subsequent observations
    collector.dispose();
    expect(collector.isDisposed).toBe(true);
    expect(collector.activeScopeKeys()).toEqual([]);

    await collector.observeToolCall({
      toolName: 'tool_four',
      isError: false,
      sessionId: 'sess-toggle',
      branchId: 'br-toggle'
    });
    expect(records).toHaveLength(2);
  });
});

describe('ScopeRegistry integration and invariant isolation', () => {
  it('strictly prohibits invariant probe scopes from creating memory experience records', async () => {
    const { store, records } = memoryStore();
    const registry = createScopeRegistry();

    // Register a domain branch (allowed memory)
    registry.register({
      sessionId: 'sess-1',
      branchId: 'br-domain',
      role: 'domain'
    });

    // Register an invariant branch (guidance_free, no memory allowed)
    registry.register({
      sessionId: 'sess-1',
      branchId: 'br-invariant',
      role: 'invariant'
    });

    const diagnostics: string[] = [];
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store,
      scopeRegistry: registry,
      onDiagnostic: (msg) => diagnostics.push(msg)
    });

    // Domain branch produces memory records normally
    await collector.observeToolCall({
      toolName: 'domain_tool',
      isError: false,
      sessionId: 'sess-1',
      branchId: 'br-domain'
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.guidance).toBe('memory');

    // Invariant branch MUST NOT append memory experience records!
    await collector.observeToolCall({
      toolName: 'invariant_probe_tool',
      isError: false,
      sessionId: 'sess-1',
      branchId: 'br-invariant'
    });
    expect(records).toHaveLength(1); // Still 1!
    expect(diagnostics.some((d) => d.includes('invariant probe scope is prohibited'))).toBe(true);

    // Turn end for invariant branch is also suppressed
    await collector.observeTurnEnd({
      kind: 'completed',
      sessionId: 'sess-1',
      branchId: 'br-invariant'
    });
    expect(records).toHaveLength(1);
  });

  it('rejects untrusted payload self-claims and isolates unknown scopes', async () => {
    const { store, records } = memoryStore();
    const registry = createScopeRegistry();

    registry.register({
      sessionId: 'sess-trust',
      branchId: 'br-domain',
      role: 'domain'
    });

    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store,
      scopeRegistry: registry
    });

    // Payload self-claiming to be domain but not registered in registry resolves to unknown
    await collector.observeToolCall({
      toolName: 'fake_tool',
      isError: false,
      sessionId: 'sess-unregistered',
      branchId: 'br-unregistered'
    });

    // Unregistered/unproven scope must NEVER produce memory experience records (plan §4 R3 / §5.2 / F4)
    expect(records).toHaveLength(0);

    // Turn end for unknown scope cannot attribute to any action
    await collector.observeTurnEnd({
      kind: 'completed',
      sessionId: 'sess-unregistered',
      branchId: 'br-unregistered'
    });
    expect(records).toHaveLength(0);
  });

  it('enforces TTL pruning and maxScopes bounded capacity', async () => {
    const { store } = memoryStore();
    let currentTime = 1000;
    const diagnostics: string[] = [];

    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store,
      maxScopes: 2,
      ttlMs: 500,
      now: () => currentTime,
      onDiagnostic: (msg) => diagnostics.push(msg)
    });

    await collector.observeToolCall({
      toolName: 't1',
      isError: false,
      sessionId: 's1',
      branchId: 'b1',
      at: 1000
    });
    await collector.observeToolCall({
      toolName: 't2',
      isError: false,
      sessionId: 's2',
      branchId: 'b2',
      at: 1000
    });

    expect(collector.activeScopeKeys()).toHaveLength(2);

    // Registering 3rd scope exceeds maxScopes (2) -> evicts oldest s1::b1
    await collector.observeToolCall({
      toolName: 't3',
      isError: false,
      sessionId: 's3',
      branchId: 'b3',
      at: 1000
    });

    expect(collector.activeScopeKeys()).toHaveLength(2);
    expect(collector.activeScopeKeys()).not.toContain('s1::b1');
    expect(diagnostics.some((d) => d.includes('scope_bucket_evicted: s1::b1'))).toBe(true);

    // Advance time past TTL (500 ms)
    currentTime = 2000;
    const pruned = collector.prune(currentTime);
    expect(pruned).toBe(2);
    expect(collector.activeScopeKeys()).toHaveLength(0);
  });

  it('deduplicates identical tool observations within the same scope', async () => {
    const { store, records } = memoryStore();
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store
    });

    const obs: HostToolObservation = {
      toolName: 'repeat_tool',
      isError: false,
      sessionId: 's-dedup',
      branchId: 'b-dedup',
      eventId: 'evt-100',
      at: 1000
    };

    await collector.observeToolCall(obs);
    expect(records).toHaveLength(1);

    // Send duplicate event with same eventId
    await collector.observeToolCall(obs);
    expect(records).toHaveLength(1); // Deduplicated!
  });

  it('redacts secrets in error classes and tool names', async () => {
    const { store, records } = memoryStore();
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store
    });

    await collector.observeToolCall({
      toolName: 'bash',
      isError: true,
      errorClass: 'ghp_CANARY_SECRET_LEAK_TOKEN',
      sessionId: 's-sec',
      branchId: 'b-sec'
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.state.summary).not.toContain('ghp_CANARY_SECRET_LEAK_TOKEN');
    expect(records[0]?.state.tokens).toContain('err:secret');
  });
  it('isolates multi-session identical branch names in ScopeRegistry and handles cross dispose cleanly (F6)', () => {
    const registry = createScopeRegistry();
    const handleA = registry.register({
      sessionId: 'sess-A',
      branchId: 'br-common',
      role: 'domain'
    });
    const handleB = registry.register({
      sessionId: 'sess-B',
      branchId: 'br-common',
      role: 'domain'
    });

    // Exact compound matching resolves correctly for both sessions
    const scopeA = registry.resolve({ sessionId: 'sess-A', branchId: 'br-common' });
    expect(scopeA).not.toBe('unknown');
    if (scopeA !== 'unknown') {
      expect(scopeA.sessionId).toBe('sess-A');
      expect(scopeA.branchId).toBe('br-common');
    }

    const scopeB = registry.resolve({ sessionId: 'sess-B', branchId: 'br-common' });
    expect(scopeB).not.toBe('unknown');
    if (scopeB !== 'unknown') {
      expect(scopeB.sessionId).toBe('sess-B');
      expect(scopeB.branchId).toBe('br-common');
    }

    // Branch-only lookup when ambiguous across multiple sessions must return 'unknown' (F6)
    expect(registry.resolve({ branchId: 'br-common' })).toBe('unknown');

    // Conflicting sessions or branches in payload return 'unknown'
    expect(registry.resolve(
      { sessionId: 'sess-A', branchId: 'br-common' },
      { sessionId: 'sess-B', branchId: 'br-common' }
    )).toBe('unknown');

    // Dispose sess-A: must NOT remove sess-B mapping
    handleA.dispose();
    expect(registry.resolve({ sessionId: 'sess-A', branchId: 'br-common' })).toBe('unknown');

    const scopeBAfter = registry.resolve({ sessionId: 'sess-B', branchId: 'br-common' });
    expect(scopeBAfter).not.toBe('unknown');
    if (scopeBAfter !== 'unknown') {
      expect(scopeBAfter.sessionId).toBe('sess-B');
    }

    // Now branch-only lookup resolves to sess-B because it is globally unique
    const scopeBOnly = registry.resolve({ branchId: 'br-common' });
    expect(scopeBOnly).not.toBe('unknown');
    if (scopeBOnly !== 'unknown') {
      expect(scopeBOnly.sessionId).toBe('sess-B');
    }
  });

  it('prohibits memory record collection for neutral-named invariant slot and unproven branch (F3/F4/F10)', async () => {
    const { store, records } = memoryStore();
    const registry = createScopeRegistry();
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store,
      scopeRegistry: registry
    });

    // 1) Unproven branch (not in registry) with neutral format sess-a1::tree-1::r1-s1 (no 'inv', slot s1)
    const neutralBranch = 'sess-a1::tree-1::r1-s1';
    const neutralSession = 'sess-a1';

    await collector.observeToolCall({
      toolName: 'probe_tool',
      isError: false,
      sessionId: neutralSession,
      branchId: neutralBranch
    });
    // Unproven branch completely skipped: no records appended (F4)
    expect(records).toHaveLength(0);

    // 2) Invariant slot with neutral name (non-inv session, non-s2 slot) registered via provenance
    const invariantHandle = registry.register({
      sessionId: neutralSession,
      branchId: neutralBranch,
      origin: 'explore_invariant',
      guidance: 'guidance_free'
    });
    expect(invariantHandle.scope.isInvariant).toBe(true);
    expect(invariantHandle.scope.guidance).toBe('guidance_free');

    await collector.observeToolCall({
      toolName: 'probe_tool',
      isError: false,
      sessionId: neutralSession,
      branchId: neutralBranch
    });
    // Invariant slot must NEVER produce memory experience records (R3 / F4 / Acceptance 1 & 3)
    expect(records).toHaveLength(0);

    // Turn end for invariant slot also produces zero records
    await collector.observeTurnEnd({
      kind: 'completed',
      sessionId: neutralSession,
      branchId: neutralBranch
    });
    expect(records).toHaveLength(0);
    invariantHandle.dispose();
  });

  it('counterfactual on identical branchId: provenance directly drives memory outcome (F3/F10)', async () => {
    const { store, records } = memoryStore();
    const registry = createScopeRegistry();
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store,
      scopeRegistry: registry
    });

    // Exact same branchId tested with domain provenance vs invariant provenance
    const testBranch = 'sess-a1::tree-1::r1-s1';
    const testSession = 'sess-a1';

    // A) Register as domain provenance: memory record IS produced
    const domainHandle = registry.register({
      sessionId: testSession,
      branchId: testBranch,
      origin: 'explore_domain',
      guidance: 'memory',
      role: 'domain'
    });
    expect(domainHandle.scope.isInvariant).toBe(false);

    await collector.observeToolCall({
      toolName: 'read_code',
      isError: false,
      sessionId: testSession,
      branchId: testBranch
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.guidance).toBe('memory');
    domainHandle.dispose();

    // B) Re-register identical branchId with invariant provenance: memory record is NOT produced
    const invHandle = registry.register({
      sessionId: testSession,
      branchId: testBranch,
      origin: 'explore_invariant',
      guidance: 'guidance_free',
      role: 'invariant'
    });
    expect(invHandle.scope.isInvariant).toBe(true);

    const prevCount = records.length;
    await collector.observeToolCall({
      toolName: 'read_code',
      isError: false,
      sessionId: testSession,
      branchId: testBranch
    });
    // Zero new records appended for invariant provenance!
    expect(records.length).toBe(prevCount);
    invHandle.dispose();
  });

  it('proves slot -s2 domain branch is NOT falsely isolated as invariant (Acceptance 1 / F3-RESIDUAL)', async () => {
    const { store, records } = memoryStore();
    const registry = createScopeRegistry();
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store,
      scopeRegistry: registry
    });

    // Slot -s2 domain branch: e.g. sess-a1::tree-1::r0-s2
    const s2Branch = 'sess-a1::tree-1::r0-s2';
    const s2Session = 'sess-a1';

    // Register with domain provenance
    const handle = registry.register({
      sessionId: s2Session,
      branchId: s2Branch,
      origin: 'explore_domain',
      guidance: 'memory',
      role: 'domain'
    });
    expect(handle.scope.isInvariant).toBe(false);
    expect(handle.scope.allowAdvice).toBe(true);

    await collector.observeToolCall({
      toolName: 'domain_tool',
      isError: false,
      sessionId: s2Session,
      branchId: s2Branch
    });

    // Domain branch in -s2 slot must successfully record memory experience
    expect(records).toHaveLength(1);
    expect(records[0]?.guidance).toBe('memory');
    handle.dispose();
  });

  it('enforces unproven branch fail-closed while supporting host-local ordinary calls (Option 2 / F9)', async () => {
    const { store, records } = memoryStore();
    const registry = createScopeRegistry();
    const collector = createHostToolExperienceCollector({
      config: baseConfig,
      store,
      scopeRegistry: registry
    });

    // 1) Unproven branch (names a branch but not in registry) -> strictly fail-closed!
    await collector.observeToolCall({
      toolName: 'unproven_tool',
      isError: false,
      branchId: 'unproven-branch'
    });
    expect(records).toHaveLength(0);

    // Turn end for unproven branch -> zero records
    await collector.observeTurnEnd({
      kind: 'completed',
      branchId: 'unproven-branch'
    });
    expect(records).toHaveLength(0);

    // 2) Host-local ordinary tool execution without branchId accumulates host baseline
    await collector.observeToolCall({
      toolName: 'host_local_bash',
      isError: false
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.guidance).toBe('memory');
  });
});
