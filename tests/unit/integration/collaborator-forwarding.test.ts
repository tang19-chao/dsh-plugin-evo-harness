/**
 * Collaborator-forwarding regressions (P0-1 family, audit round 2).
 *
 * Covers the three delivery seams the 7307d7d refactor dropped in one sweep:
 *  - P1-1 (INT-2): `options.model` reaches the default composer's judge even
 *    when `deps.proposer` is injected (the old ternary forced model=undefined);
 *  - P1-9 (VCI-1): the DSH-resolved MCP clients reach the memory bridge (the
 *    deferred provider reads the holder at initialize time) and the JitRL
 *    mirror (rebuilt once once detection settles).
 */
import { describe, expect, it } from 'vitest';

import { parseEvoHarnessConfig } from '../../../src/config';
import { createDualTrackProposer } from '../../../src/harness2';
import { buildOrchestratorDeps, createEvoHarnessPlugin } from '../../../src/index';
import type { CollaboratorHolder } from '../../../src/index';
import {
  createFakeContext,
  createScriptedModel,
  createScriptedRunner,
  e2eConfig,
  makeClock,
  makeIdFactory,
  mem0LikeServer
} from '../../e2e/fixtures';

describe('P1-1: options.model reaches the composer judge with deps.proposer injected', () => {
  it('routes compose judging to the injected model while the custom proposer uses its own', async () => {
    const judgeModel = createScriptedModel();
    const proposerModel = createScriptedModel();
    const now = makeClock();
    const plugin = createEvoHarnessPlugin({
      config: e2eConfig(),
      model: judgeModel,
      clients: [mem0LikeServer().client],
      runBranch: createScriptedRunner(now),
      now,
      newId: makeIdFactory('p1-1'),
      // Tests inject the collaborators directly; no host context is needed.
      resolveDshCollaborators: false,
      deps: {
        proposer: createDualTrackProposer({ model: proposerModel, now, newId: makeIdFactory('custom') })
      }
    });

    const result = await plugin.run({
      sessionId: 'sess-p1-1',
      task: plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).toBe('composed');
    // The composer's judge call must reach the explicitly injected options.model.
    expect(judgeModel.requests.some((request) => request.purpose === 'compose')).toBe(true);
    // ...while the injected proposer keeps serving its own model.
    expect(proposerModel.requests.some((request) => request.purpose === 'propose')).toBe(true);
    expect(proposerModel.requests.every((request) => request.purpose !== 'compose')).toBe(true);
  });
});

describe('P1-9: DSH-resolved MCP clients reach the memory bridge and the JitRL mirror', () => {
  it('binds the memory bridge through the holder-backed deferred provider', async () => {
    const config = parseEvoHarnessConfig(e2eConfig());
    const diagnostics: string[] = [];
    const holder: CollaboratorHolder = {};
    const { deps } = buildOrchestratorDeps(config, { now: makeClock() }, {}, diagnostics, holder);

    // No options.clients / options.listClients: the bridge was built with the
    // deferred provider only. The clients "arrive" once detection settles.
    holder.clients = [mem0LikeServer('holder-mem0').client];
    await deps.memory.initialize();

    expect(deps.memory.descriptor.driverKind).not.toBe('unbound');
  });

  it('attaches the DSH-resolved tools client to the JitRL mirror after detection', async () => {
    const { ctx } = createFakeContext();
    const hostCtx = {
      ...ctx,
      tools: {
        schemas: (): readonly unknown[] => [{ name: 'shell', description: 'run a command' }],
        get: (name: string) => ({ name, execute: async () => ({}) })
      }
    };
    const plugin = createEvoHarnessPlugin({
      config: e2eConfig({ config: { jitrl: { enabled: true, store: { mirrorToMemoryBridge: true } } } }),
      now: makeClock()
    }, hostCtx);

    await plugin.collaborators;

    expect(plugin.diagnostics.join(' ')).toContain(
      'jitrl mirror: DSH-resolved MCP client attached (server dsh-tools)'
    );
  });
});
