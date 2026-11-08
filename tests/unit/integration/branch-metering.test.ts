/**
 * B8 / A6 H12 (rev6 audit): probe-stage metering through the production DSH
 * resolver.
 *
 * B8's finding was that the same-process probe executor recorded every call as
 * `unmetered`, so the host's budget never bounded probes. The fix wires the
 * host's EXISTING `agentLoop.ledgerSettlement` into
 * `resolveDshCollaborators(..., { branch: { metering } })`: one settlement
 * object, no second ledger manager.
 *
 * STRUCTURAL LIMIT (recorded by the test, not hidden): the public 26-key options
 * have no independent `ledgerSettlement` seam. A host supplies a ledger via
 * `agentLoop`, and when `agentLoop` is present its executor keeps priority over
 * the resolved same-process one. The wiring below is therefore reachable through
 * the resolver (this test) and through `src/index.ts`'s collaborator call; it
 * does not by itself make every production probe metered. B8 is a PARTIAL fix.
 */
import { describe, expect, it } from 'vitest';

import { ModelCallRegistry, resolveDshCollaborators } from '../../../src/dsh-bridge';
import { createEvoHarnessPlugin } from '../../../src/index';
import { createLedgerReservationManager, twoPhaseSettlementFor } from '../../../src/ledger';
import type { IsolatedBranchContext } from '../../../src/types/contracts';
import { createFakeContext, createPatchAwareHostLlm, e2eConfig, makeClock } from '../../e2e/fixtures';

const RATE_CARD = {
  modelId: 'test/branch-metering',
  inputRatePerMillion: 1_000_000,
  outputRatePerMillion: 2_000_000,
  reasoningSeparatelyBilled: false,
  conservativeFallbackCostMicros: 500
} as const;

/** A minimal ctx.llm whose stream answers one probe call. */
function fakeHostLlm(): { stream(options: unknown): AsyncIterable<unknown>; calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async *stream(): AsyncIterable<unknown> {
      state.calls += 1;
      yield { type: 'text-delta', index: 0, text: 'metered probe deliverable' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  };
}

function probeContext(): IsolatedBranchContext {
  return {
    branchId: 'branch-metering',
    sessionId: 'session-metering',
    namespace: 'harness2:probe_branch-metering',
    task: { id: 'task-metering', prompt: 'Run the metered probe.' },
    patch: {
      id: 'patch-metering',
      sessionId: 'session-metering',
      branchId: 'branch-metering',
      origin: 'domain',
      purpose: 'explore',
      guidance: 'memory',
      label: 'metering fixture',
      rationale: 'a candidate patch that must still be metered',
      edits: {
        guardrails: { kind: 'guardrails', appendRules: ['keep the probe metered'] }
      },
      createdAt: 0
    },
    mountedSurfaces: ['guardrails'],
    signal: new AbortController().signal
  };
}

describe('B8: probe-stage ledger wiring through resolveDshCollaborators', () => {
  it('reserves and finally settles exactly one ledger call per probe model call', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      enforceHardBounds: true,
      defaultRateCard: RATE_CARD
    });
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'branch-metering-test' });
    const registry = new ModelCallRegistry();
    const llm = fakeHostLlm();
    const { ctx } = createFakeContext();

    const collaborators = await resolveDshCollaborators(
      { ...ctx, llm },
      {
        config: e2eConfig(),
        branch: { metering: { ledgerSettlement: settlement, registry } }
      }
    );

    // Three probe dispatches, each through the SAME resolved executor.
    for (let index = 0; index < 3; index += 1) {
      const result = await collaborators.runBranch(probeContext());
      expect(result.status).toBe('succeeded');
      expect(result.deliverable?.content).toBe('metered probe deliverable');
    }
    expect(llm.calls).toBe(3);

    const probeRecords = registry.snapshot().filter((record) => record.stage === 'probe');
    expect(probeRecords).toHaveLength(3);
    for (const record of probeRecords) {
      expect(record.purpose).toBe('probe');
      expect(record.reservationId).toBeDefined();
      expect(record.settlement).toBe('final');
      expect(record.reservedMicros).toBeGreaterThan(0);
      expect(record.provenance).not.toBe('none');
    }

    // The ledger saw exactly the probe calls: three reserves, three final
    // settles, and three settled identities - no hidden second manager.
    expect(manager.getMeteringStatus().reserveAttempts).toBe(3);
    expect(manager.getMeteringStatus().settleCount).toBe(3);
    const identities = settlement.identities();
    expect(identities).toHaveLength(3);
    expect(identities.every((identity) => identity.state === 'settled')).toBe(true);
    expect(new Set(identities.map((identity) => identity.reservationId)).size).toBe(3);
  });

  it('without the branch metering wiring the same probe calls stay unmetered (pinned)', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      defaultRateCard: RATE_CARD
    });
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'branch-metering-test-unwired' });
    const registry = new ModelCallRegistry();
    const { ctx } = createFakeContext();

    const collaborators = await resolveDshCollaborators(
      { ...ctx, llm: fakeHostLlm() },
      { config: e2eConfig(), branch: { metering: { registry } } }
    );
    const result = await collaborators.runBranch(probeContext());
    expect(result.status).toBe('succeeded');

    const probeRecords = registry.snapshot().filter((record) => record.stage === 'probe');
    expect(probeRecords).toHaveLength(1);
    expect(probeRecords[0]?.reservationId).toBeUndefined();
    expect(probeRecords[0]?.settlement).toBe('none');
    expect(probeRecords[0]?.provenance).toBe('none');
    // No reservation -> no reserved amount. The old record wrote the 10_000
    // default estimate and made `stats().reserved` count a reservation that
    // never happened.
    expect(probeRecords[0]?.reservedMicros).toBe(0);
    // The unused settlement proves no manager was reached.
    expect(manager.getMeteringStatus().reserveAttempts).toBe(0);
    expect(manager.getMeteringStatus().settleCount).toBe(0);
    expect(settlement.identities()).toHaveLength(0);
  });

  it('the plugin hands the SAME host settlement to the resolver (single object, explicit diagnostic)', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      defaultRateCard: RATE_CARD
    });
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'plugin-branch-metering' });
    const { ctx } = createFakeContext();

    const plugin = createEvoHarnessPlugin(
      {
        config: e2eConfig({ config: { jitrl: { enabled: false } } }),
        now: makeClock(),
        agentLoop: { ledgerSettlement: settlement }
      },
      ctx
    );
    await plugin.collaborators;
    expect(plugin.diagnostics.join('\n')).toContain(
      'branch metering: the DSH-resolved same-process probe executor shares agentLoop.ledgerSettlement'
    );
    // Merely resolving collaborators must not reserve or settle anything.
    expect(manager.getMeteringStatus().reserveAttempts).toBe(0);
    expect(settlement.identities()).toHaveLength(0);
    await plugin.dispose();
  });

  it('meters REAL production probes through a ledger-only agentLoop (no agent executor)', async () => {
    const manager = createLedgerReservationManager({
      enabled: true,
      defaultRateCard: RATE_CARD
    });
    const settlement = twoPhaseSettlementFor(manager, { consumer: 'plugin-production-probes' });
    const host = createPatchAwareHostLlm();
    const { ctx } = createFakeContext();
    const plugin = createEvoHarnessPlugin(
      {
        config: e2eConfig({ config: { jitrl: { enabled: false } } }),
        now: makeClock(),
        agentLoop: { ledgerSettlement: settlement }
      },
      { ...ctx, llm: host }
    );
    await plugin.collaborators;
    expect(plugin.diagnostics.join('\n')).toContain(
      'branch metering: the DSH-resolved same-process probe executor shares agentLoop.ledgerSettlement'
    );

    const result = await plugin.run({
      sessionId: 'sess-metered-production',
      task: plugin.makeTask({ id: 'task-metered-production', prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });
    expect(result.probesRun).toBeGreaterThan(1);
    // Every probe (reference + candidates) reserved AND finally settled exactly
    // once: the resolver executor - not an agent loop with no model - did the
    // work, and it used the host settlement object.
    expect(manager.getMeteringStatus().reserveAttempts).toBe(result.probesRun);
    expect(manager.getMeteringStatus().settleCount).toBe(result.probesRun);
    const identities = settlement.identities();
    expect(identities).toHaveLength(result.probesRun);
    expect(identities.every((identity) => identity.state === 'settled')).toBe(true);
    await plugin.dispose();
  });
});