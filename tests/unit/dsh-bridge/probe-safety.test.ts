/**
 * rev5 P2-3/P2-4: the composed probe-safety gate and its wiring into the agent
 * loop executor.
 *
 * The four properties under test map to the acceptance contract:
 *   1. read-only allowlist (tier 1): allowlisted/not-allowlisted/explicitly-denied,
 *      and the branch "no policy" hole closed for probe calls;
 *   2. authorization ledger (tier 2): no-grant / authorized / wrong-scope;
 *   3. inert by default: a host that never opted in keeps checks at zero and
 *      every call running;
 *   4. wiring: the executor calls its tool runtime ONLY after the gate allows —
 *      a refusal becomes a structured tool error, never a host call.
 */
import { describe, expect, it } from 'vitest';
import { createToolFaceRegistry } from '../../../src/cordis-seams/tool-face';
import { createProbeAuthorizationLedger } from '../../../src/jitrl/runtime-control';
import {
  createProbeSafetyGate,
  validateProbeSafetyCounters,
  type ProbeSafetyCounters
} from '../../../src/dsh-bridge/probe-safety';
import {
  createAgentLoopExecutor,
  type AgentLoopDecision,
  type AgentPlanRequest,
  type AgentToolCallOutcome,
  type AgentToolCallRequest,
  type AgentToolRuntime
} from '../../../src/dsh-bridge/agent-loop-executor';
import type { IsolatedBranchContext } from '../../../src/types/contracts';
import { makeClock, makePatch, makeTask } from '../cordis-seams/fixtures';

function registryFor(branchId: string): ToolFaceRegistry2 {
  const registry = createToolFaceRegistry({ now: makeClock() });
  registry.install({ branchId, allowTools: ['read_note', 'search_memory'] });
  return registry;
}
type ToolFaceRegistry2 = ReturnType<typeof createToolFaceRegistry>;

describe('createProbeSafetyGate — tier 1 (read-only allowlist)', () => {
  it('is inert without any fence: allows and records nothing', () => {
    const gate = createProbeSafetyGate();
    expect(gate.configured).toBe(false);
    const decision = gate.decide({ toolName: 'shell', branchId: 'br-1' });
    expect(decision.allowed).toBe(true);
    expect(decision.tier).toBe('none');
    expect(decision.code).toBe('unconfigured');
    const stats = gate.stats();
    expect(stats.checks).toBe(1);
    expect(stats.allowlistTier.checks).toBe(0);
    expect(stats.authorizationTier.checks).toBe(0);
    expect(validateProbeSafetyCounters(stats, { policyInstalled: false })).toEqual([]);
  });

  it('allows an allowlisted branch call and denies a tool outside the list', () => {
    const gate = createProbeSafetyGate({ toolFace: registryFor('br-1') });
    expect(gate.decide({ toolName: 'read_note', branchId: 'br-1' })).toMatchObject({
      allowed: true,
      tier: 'allowlist',
      code: 'allowlisted'
    });
    expect(gate.decide({ toolName: 'shell', branchId: 'br-1' })).toMatchObject({
      allowed: false,
      tier: 'allowlist',
      code: 'not-allowlisted'
    });
  });

  it('honours an explicit denial even for a listed tool', () => {
    const registry = createToolFaceRegistry({ now: makeClock() });
    registry.install({
      branchId: 'br-1',
      allowTools: ['read_note', 'write_note'],
      denyTools: [{ toolName: 'write_note', reason: 'probe branches stay read-only' }]
    });
    const gate = createProbeSafetyGate({ toolFace: registry });
    expect(gate.decide({ toolName: 'write_note', branchId: 'br-1' })).toMatchObject({
      allowed: false,
      code: 'explicitly-denied'
    });
  });

  it('closes the branch no-policy hole instead of inheriting the registry transparency', () => {
    const registry = createToolFaceRegistry({ now: makeClock() });
    // No policy installed for br-2: the registry answers allowed/no-policy.
    const gate = createProbeSafetyGate({ toolFace: registry });
    const decision = gate.decide({ toolName: 'shell', branchId: 'br-2' });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('no-policy');
    const stats = gate.stats();
    expect(stats.branchNoPolicy).toBe(1);
    // The invariant check flags exactly this state when a policy SHOULD exist.
    expect(validateProbeSafetyCounters(stats, { policyInstalled: true }).join('; ')).toContain('no-policy');
    expect(validateProbeSafetyCounters(stats, { policyInstalled: false })).toEqual([]);
  });

  it('keeps the registry transparency for host-level calls, counted separately', () => {
    const gate = createProbeSafetyGate({ toolFace: registryFor('br-1') });
    const decision = gate.decide({ toolName: 'shell' });
    expect(decision.allowed).toBe(true);
    expect(gate.stats().hostChecks).toBe(1);
    expect(gate.stats().branchChecks).toBe(0);
  });

  it('refuses a nameless call instead of treating it as out of scope', () => {
    const gate = createProbeSafetyGate({ toolFace: registryFor('br-1') });
    expect(gate.decide({ toolName: '   ', branchId: 'br-1' })).toMatchObject({
      allowed: false,
      code: 'invalid-request'
    });
  });

  it('fails closed on a disposed registry', () => {
    const registry = registryFor('br-1');
    registry.dispose();
    const gate = createProbeSafetyGate({ toolFace: registry });
    expect(gate.decide({ toolName: 'read_note', branchId: 'br-1' })).toMatchObject({
      allowed: false,
      code: 'registry-disposed'
    });
  });
});

describe('createProbeSafetyGate — tier 2 (authorization ledger)', () => {
  it('denies with no-grant before any grant exists, then authorizes with one', () => {
    const ledger = createProbeAuthorizationLedger({ now: makeClock() });
    const gate = createProbeSafetyGate({ toolFace: registryFor('br-1'), ledger });
    expect(gate.decide({ toolName: 'read_note', branchId: 'br-1' })).toMatchObject({
      allowed: false,
      tier: 'authorization',
      code: 'no-grant'
    });
    const grant = ledger.grant({
      kind: 'external-tool-call',
      grantedBy: 'operator:ci',
      reason: 'unit test: allow the probe to call its read-only tools',
      branchId: 'br-1'
    });
    expect(gate.decide({ toolName: 'read_note', branchId: 'br-1' })).toMatchObject({
      allowed: true,
      tier: 'authorization',
      code: 'authorized',
      authorization: { grantId: grant.grantId }
    });
  });

  it('refuses a session-only grant for a branch call (ADR 0006 D-P4-1)', () => {
    const ledger = createProbeAuthorizationLedger({ now: makeClock() });
    ledger.grant({
      kind: 'external-tool-call',
      grantedBy: 'operator:ci',
      reason: 'session-scoped only',
      sessionId: 'sess-1'
    });
    const gate = createProbeSafetyGate({ toolFace: registryFor('br-1'), ledger });
    expect(gate.decide({ toolName: 'read_note', branchId: 'br-1', sessionId: 'sess-1' })).toMatchObject({
      allowed: false,
      code: 'session-cannot-authorize-branch'
    });
  });

  it('lets the allowlist refusal win before the ledger is consulted', () => {
    const ledger = createProbeAuthorizationLedger({ now: makeClock() });
    const gate = createProbeSafetyGate({ toolFace: registryFor('br-1'), ledger });
    const before = ledger.stats().checks;
    const decision = gate.decide({ toolName: 'shell', branchId: 'br-1' });
    expect(decision.tier).toBe('allowlist');
    expect(ledger.stats().checks).toBe(before);
  });

  it('fails closed on a disposed ledger', () => {
    const ledger = createProbeAuthorizationLedger({ now: makeClock() });
    ledger.grant({ kind: 'external-tool-call', grantedBy: 'operator:ci', reason: 'allow', branchId: 'br-1' });
    ledger.dispose();
    const gate = createProbeSafetyGate({ toolFace: registryFor('br-1'), ledger });
    expect(gate.decide({ toolName: 'read_note', branchId: 'br-1' })).toMatchObject({
      allowed: false,
      code: 'ledger-disposed'
    });
  });
});

describe('createProbeSafetyGate — counters', () => {
  it('keeps every closure the validators rely on', () => {
    const ledger = createProbeAuthorizationLedger({ now: makeClock() });
    const gate = createProbeSafetyGate({ toolFace: registryFor('br-1'), ledger });
    gate.decide({ toolName: 'read_note', branchId: 'br-1' });
    gate.decide({ toolName: 'shell', branchId: 'br-1' });
    gate.decide({ toolName: 'read_note' });
    const stats: ProbeSafetyCounters = gate.stats();
    expect(stats.checks).toBe(stats.allowed + stats.denied);
    expect(stats.branchChecks + stats.hostChecks).toBe(stats.checks);
    expect(validateProbeSafetyCounters(stats, { policyInstalled: true })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// executor wiring: the tool runtime is only called when the gate allows
// ---------------------------------------------------------------------------

function scriptedPlanner(decisions: readonly AgentLoopDecision[]): {
  planNext: (request: AgentPlanRequest) => Promise<AgentLoopDecision>;
} {
  let cursor = 0;
  return {
    async planNext(request: AgentPlanRequest): Promise<AgentLoopDecision> {
      void request;
      const decision = decisions[cursor];
      cursor += 1;
      if (decision === undefined) {
        throw new Error('the scripted planner ran out of decisions');
      }
      return decision;
    }
  };
}

function recordingTools(): AgentToolRuntime & { readonly calls: AgentToolCallRequest[] } {
  const calls: AgentToolCallRequest[] = [];
  return {
    calls,
    listTools: () => ['read_note', 'shell'],
    async execute(request: AgentToolCallRequest): Promise<AgentToolCallOutcome> {
      calls.push(request);
      return { result: 'ok', text: 'ok' };
    }
  };
}

function makeContext(overrides: Partial<IsolatedBranchContext> = {}): IsolatedBranchContext {
  return {
    branchId: 'br-1',
    sessionId: 'sess-1',
    namespace: 'harness2:probe_br-1',
    task: makeTask(),
    patch: makePatch(),
    mountedSurfaces: ['system_prompt', 'tool_guidance'],
    signal: new AbortController().signal,
    ...overrides
  };
}

function runOnce(
  safety: ReturnType<typeof createProbeSafetyGate>,
  tools: AgentToolRuntime & { readonly calls: AgentToolCallRequest[] },
  toolName = 'shell'
): Promise<unknown> {
  const executor = createAgentLoopExecutor(
    {
      model: scriptedPlanner([
        { kind: 'tool', toolName, toolArguments: { cmd: 'ls' }, text: 'inspect' },
        { kind: 'final', text: 'done', finishReason: 'stop' }
      ]),
      tools,
      safety
    },
    makeClock()
  );
  return executor.runBranch(makeContext());
}

describe('agent loop executor — probe-safety wiring', () => {
  it('never calls the tool runtime when the gate refuses, and surfaces the refusal', async () => {
    const tools = recordingTools();
    const result = (await runOnce(createProbeSafetyGate({ toolFace: registryFor('br-1') }), tools)) as {
      readonly steps?: readonly { readonly kind: string }[];
      readonly toolErrors?: readonly { readonly code?: string; readonly message: string }[];
      readonly status: string;
    };
    expect(tools.calls).toHaveLength(0);
    const refusal = result.toolErrors?.find((entry) => entry.code === 'probe_safety_denied');
    expect(refusal?.message).toContain('not-allowlisted');
    expect(result.steps?.map((step) => step.kind)).toContain('error');
    expect(result.status).toBe('succeeded');
  });

  it('executes exactly once when the gate allows the call', async () => {
    const tools = recordingTools();
    const gate = createProbeSafetyGate({
      toolFace: registryFor('br-1'),
      ledger: (() => {
        const ledger = createProbeAuthorizationLedger({ now: makeClock() });
        ledger.grant({
          kind: 'external-tool-call',
          grantedBy: 'operator:test',
          reason: 'integration test grant',
          branchId: 'br-1'
        });
        return ledger;
      })()
    });
    await runOnce(gate, tools, 'read_note');
    expect(tools.calls).toHaveLength(1);
    expect(tools.calls[0]?.toolName).toBe('read_note');
    expect(gate.stats().allowed).toBe(1);
    expect(gate.stats().denied).toBe(0);
  });

  it('keeps the loop byte-for-byte unchanged when no gate is attached', async () => {
    const tools = recordingTools();
    await runOnce(createProbeSafetyGate(), tools);
    expect(tools.calls).toHaveLength(1);
  });
});
