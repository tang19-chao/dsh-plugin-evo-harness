/**
 * rev5 P4-1 (C-7): the plugin handle aggregates the pure writable handshake.
 *
 * The module-level matrix (three states, fail-closed reasons, zero tool calls)
 * is covered by `src/memory-bridge/status.ts`'s own tests and by the t16
 * independent probe. THIS file covers the integration half the captain reserved
 * for t23: `plugin.memory` must (a) read the bridge's last auto-discovery
 * result, (b) use the SAME resolved execution profile the orchestrator
 * enforces, (c) render Recall-Only for every non-'yes' verdict, and (d) never
 * turn a granted permission alone into Read-Write.
 *
 * The stub discovery below is deliberately structural: `resolveMemoryWritableStatus`
 * reads only `descriptor`, `tools` and `selection.candidate.binding`, so a
 * minimal object keeps the integration test honest about what the handle adds
 * (the wiring) without re-testing the pure function's field matrix.
 */
import { describe, expect, it } from 'vitest';
import { createEvoHarnessPlugin } from '../../../src/index';
import type { AutoDiscoveryResult } from '../../../src/memory-bridge';
import type { IMemoryBridge } from '../../../src/types/contracts';
import { resolveExecutionProfile } from '../../../src/runtime/execution-profile';

/** A vector_fact backend that advertises a writable commit tool. */
function writableDiscovery(): AutoDiscoveryResult {
  return {
    descriptor: {
      driverKind: 'vector_fact',
      serverId: 'handle-status-mem0',
      backendLabel: 'vector_fact (handle-status stub)',
      capabilities: {
        metadataFiltering: true,
        namespaces: true,
        negativePolarity: true,
        temporal: false,
        supportsPrune: true
      },
      boundAt: 0,
      diagnostics: ['stub discovery: no network, no client']
    },
    tools: [
      {
        name: 'add_memory',
        description: 'store one governed lesson',
        inputSchema: { type: 'object', properties: { content: { type: 'string' } } }
      },
      { name: 'search_memory', description: 'recall lessons' }
    ],
    selection: {
      candidate: { binding: { recall: 'search_memory', commit: 'add_memory' } }
    }
    // The remaining AutoDiscoveryResult fields (driver/client/context) are never
    // read by the handshake; see the file header for why this is structural.
  } as unknown as AutoDiscoveryResult;
}

interface StubBridge extends IMemoryBridge {
  /** Counters prove the handle read is a pure data projection. */
  readonly calls: { listTools: number; tool: number; initialize: number; commit: number };
}

/** A bridge that only publishes data — no client, no clock, no I/O. */
function stubBridge(discovery: AutoDiscoveryResult | null, exposeAccessor = true): StubBridge {
  const calls = { listTools: 0, tool: 0, initialize: 0, commit: 0 };
  const bridge = {
    descriptor: discovery?.descriptor ?? {
      driverKind: 'unbound',
      serverId: null,
      backendLabel: 'unbound (stub)',
      capabilities: {
        metadataFiltering: false,
        namespaces: false,
        negativePolarity: false,
        temporal: false,
        supportsPrune: false
      },
      boundAt: 0,
      diagnostics: []
    },
    calls,
    initialize: async () => bridge.descriptor,
    recall: async () => {
      throw new Error('the handle status read must not recall');
    },
    commit: async () => {
      calls.commit += 1;
      throw new Error('the handle status read must not commit');
    },
    isolate: async () => {
      throw new Error('the handle status read must not isolate');
    },
    promote: async () => {
      throw new Error('the handle status read must not promote');
    },
    prune: async () => {
      throw new Error('the handle status read must not prune');
    },
    dispose: async () => undefined
  } as unknown as StubBridge;
  if (exposeAccessor) {
    (bridge as unknown as { discoveryResult: () => AutoDiscoveryResult | null }).discoveryResult =
      () => discovery;
  }
  return bridge;
}

describe('plugin.memory: default assembly stays Recall-Only', () => {
  it('reports the denied permission from the default profile, never a guessed yes', () => {
    const plugin = createEvoHarnessPlugin({ config: { logging: { level: 'silent' } } });
    const status = plugin.memory;
    expect(status.writable).toBe('no');
    expect(status.mode).toBe('recall-only');
    expect(status.label).toBe('Recall-Only');
    expect(status.reason).toContain('denied');
    // The profile the orchestrator enforces is the one the handle reads.
    expect(plugin.config.execution.mode).toBe('shadow');
    expect(status.diagnostics.some((line) => line.includes('execution mode: shadow'))).toBe(true);
  });

  it('a granted permission alone can never render Read-Write without backend evidence', () => {
    // TEST-ONLY assembly: the documented deps.executionProfile seam. Production
    // never constructs this input (see tests/unit/memory-bridge/production-defaults.test.ts).
    const plugin = createEvoHarnessPlugin({
      config: { logging: { level: 'silent' } },
      deps: { executionProfile: resolveExecutionProfile({ memoryRealWrites: true }) }
    });
    const status = plugin.memory;
    expect(status.writable).toBe('unknown');
    expect(status.mode).toBe('recall-only');
    expect(status.label).toBe('Recall-Only');
    expect(status.reason).toContain('not published a descriptor or binding');
  });
});

describe('plugin.memory: the aggregation reads the bridge discovery', () => {
  it('renders Read-Write ONLY when permission and advertised commit evidence agree', () => {
    const bridge = stubBridge(writableDiscovery());
    const plugin = createEvoHarnessPlugin({
      config: { logging: { level: 'silent' } },
      deps: { memory: bridge, executionProfile: resolveExecutionProfile({ memoryRealWrites: true }) }
    });
    const status = plugin.memory;
    expect(status.writable).toBe('yes');
    expect(status.mode).toBe('read-write');
    expect(status.label).toBe('Read-Write');
    expect(status.reason).toContain('add_memory');
    // Pure data projection: no tools/list, no tools/call, no initialize, no commit.
    expect(bridge.calls).toEqual({ listTools: 0, tool: 0, initialize: 0, commit: 0 });
  });

  it('a denied profile outranks a writable backend (permission is decisive)', () => {
    const bridge = stubBridge(writableDiscovery());
    const plugin = createEvoHarnessPlugin({
      config: { logging: { level: 'silent' } },
      deps: { memory: bridge }
    });
    const status = plugin.memory;
    expect(status.writable).toBe('no');
    expect(status.label).toBe('Recall-Only');
    expect(bridge.calls).toEqual({ listTools: 0, tool: 0, initialize: 0, commit: 0 });
  });

  it('an injected bridge without the diagnostic accessor stays unknown, not yes', () => {
    const bridge = stubBridge(writableDiscovery(), false);
    const plugin = createEvoHarnessPlugin({
      config: { logging: { level: 'silent' } },
      deps: { memory: bridge, executionProfile: resolveExecutionProfile({ memoryRealWrites: true }) }
    });
    const status = plugin.memory;
    expect(status.writable).toBe('unknown');
    expect(status.mode).toBe('recall-only');
    expect(status.label).toBe('Recall-Only');
  });

  it('is a repeatable read: same bytes in, same status out, diagnostics unchanged', () => {
    const bridge = stubBridge(writableDiscovery());
    const plugin = createEvoHarnessPlugin({
      config: { logging: { level: 'silent' } },
      deps: { memory: bridge, executionProfile: resolveExecutionProfile({ memoryRealWrites: true }) }
    });
    const before = JSON.stringify(plugin.memory);
    const second = JSON.stringify(plugin.memory);
    expect(second).toBe(before);
    expect(bridge.calls).toEqual({ listTools: 0, tool: 0, initialize: 0, commit: 0 });
  });
});
