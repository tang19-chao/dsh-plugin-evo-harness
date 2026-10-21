/**
 * SPI + bridge facade tests: the MCP client boundary is injectable/mockable and
 * recall/commit/promote map onto it; unbound backends degrade deterministically.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createDriverContext } from '../../../src/memory-bridge/auto-discovery';
import { createMemoryBridge } from '../../../src/memory-bridge/bridge';
import { createDriverForKind } from '../../../src/memory-bridge/drivers/index';
import { callToolWithTimeout, collectText } from '../../../src/memory-bridge/spi';
import type { McpClient, McpToolCallResult, McpToolDescriptor } from '../../../src/memory-bridge/spi';
import type { IMemoryBridge } from '../../../src/types/contracts';
import { vectorFactServer } from './mocks/mock-mcp';
import {
  BRANCH_A_NS,
  FIXED_NOW,
  GLOBAL_NS,
  branchScope,
  globalLesson,
  memoryConfig,
  validLesson
} from './fixtures';

describe('SPI boundary', () => {
  it('is satisfied by a hand-rolled plain-object client (no host types)', async () => {
    const tools: readonly McpToolDescriptor[] = [
      {
        name: 'search_memory',
        inputSchema: { properties: { query: { type: 'string' } } }
      },
      {
        name: 'add_memory',
        inputSchema: { properties: { text: { type: 'string' }, user_id: { type: 'string' } } }
      }
    ];
    const calls: string[] = [];
    const client: McpClient = {
      serverId: 'hand-rolled',
      async listTools() {
        return tools;
      },
      async callTool(name: string) {
        calls.push(name);
        if (name === 'search_memory') {
          return { content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      }
    };
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [client] });
    const descriptor = await bridge.initialize();
    expect(descriptor.driverKind).toBe('vector_fact');
    const commit = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(commit.accepted).toBe(true);
    await bridge.recall({ scope: branchScope(), text: 'tool argument validation' });
    expect(calls).toContain('add_memory');
    expect(calls).toContain('search_memory');
  });
});

describe('driver SPI', () => {
  it('is driven directly by a hand-built context (no host, no bridge)', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const tools = await server.client.listTools();
    const binding = { recall: 'search_memory', commit: 'add_memory' };
    const context = createDriverContext(server.client, tools, memoryConfig(), binding, () => FIXED_NOW);
    const driver = createDriverForKind('vector_fact', binding);
    expect(driver?.kind).toBe('vector_fact');
    expect(driver?.binding.recall).toBe('search_memory');
    expect(driver?.capabilities.metadataFiltering).toBe(true);

    const write = await driver?.commit(context, {
      lesson: validLesson(),
      namespace: BRANCH_A_NS,
      now: FIXED_NOW
    });
    expect(write?.persisted).toBe(true);

    const read = await driver?.recall(context, {
      query: { scope: branchScope(), text: 'tool argument validation' },
      namespace: BRANCH_A_NS,
      namespaces: [BRANCH_A_NS],
      limit: 5,
      fingerprint: 'tool argument validation',
      now: FIXED_NOW
    });
    expect(read?.records.map((record) => record.lesson.id)).toEqual(['L-1']);
  });

  it('lets a fake MCP client fail without leaking host errors', async () => {
    const client: McpClient = {
      serverId: 'flaky',
      async listTools() {
        return [{ name: 'search_memory' }, { name: 'add_memory' }];
      },
      async callTool(name: string) {
        return { isError: true, content: [{ type: 'text', text: name + ' exploded' }] };
      }
    };
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [client] });
    await bridge.initialize();
    const commit = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(commit.accepted).toBe(false);
    expect(commit.persisted).toBe(false);
    expect(commit.violations[0]?.severity).toBe('block');
  });
});

describe('UniversalMemoryBridge', () => {
  it('structurally satisfies the frozen IMemoryBridge facade', async () => {
    const bridge: IMemoryBridge = createMemoryBridge({ config: memoryConfig(), clients: [] });
    expect(typeof bridge.initialize).toBe('function');
    expect(typeof bridge.recall).toBe('function');
    expect(typeof bridge.commit).toBe('function');
    expect(typeof bridge.isolate).toBe('function');
    expect(typeof bridge.promote).toBe('function');
    expect(typeof bridge.prune).toBe('function');
    expect(typeof bridge.dispose).toBe('function');
    expect(bridge.descriptor.driverKind).toBe('unbound');
    const inserted: IMemoryBridge = bridge;
    expect(inserted).toBe(bridge);
  });

  it('maps recall, commit and branch promotion onto the injected MCP client', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const bridge = createMemoryBridge({
      config: memoryConfig({ recallLimit: 6, namespacePrefix: 'harness2' }),
      clients: [server.client],
      now: () => FIXED_NOW
    });
    const descriptor = await bridge.initialize();
    expect(descriptor.driverKind).toBe('vector_fact');
    expect(descriptor.serverId).toBe('mem0');
    expect(descriptor.backendLabel).toContain('vector');
    expect(descriptor.capabilities).toEqual({
      metadataFiltering: true,
      namespaces: true,
      negativePolarity: true,
      temporal: false,
      supportsPrune: true
    });

    const commit = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(commit.accepted).toBe(true);
    expect(commit.persisted).toBe(true);
    expect(commit.namespace).toBe(BRANCH_A_NS);
    expect(commit.driverKind).toBe('vector_fact');

    const writeCall = server.lastCall('add_memory');
    expect(writeCall).toBeDefined();
    expect(String(writeCall?.args.text)).toContain('# 功能名：Pin the failing tool signature');
    const metadata = writeCall?.args.metadata as Record<string, unknown>;
    expect(metadata.namespace).toBe(BRANCH_A_NS);
    expect(metadata.polarity).toBe('positive');
    expect(metadata.whenNotToApply).toEqual(['offline sandbox']);
    expect(writeCall?.args.user_id).toBe(BRANCH_A_NS);

    const recall = await bridge.recall({ scope: branchScope(), text: 'tool keeps failing argument validation' });
    expect(recall.driverKind).toBe('vector_fact');
    expect(recall.positiveLessons.map((lesson) => lesson.id)).toEqual(['L-1']);
    expect(recall.negativeLessons).toEqual([]);
    expect(recall.lessons.length).toBe(recall.positiveLessons.length + recall.negativeLessons.length);
    expect(recall.confidence).toBeCloseTo(0.9, 6);
    expect(recall.degraded).toBe(false);

    const promoted = await bridge.promote(validLesson(), { from: branchScope() });
    expect(promoted.accepted).toBe(true);
    expect(promoted.persisted).toBe(true);
    expect(promoted.namespace).toBe(GLOBAL_NS);
    const globalWrite = server.callsTo('add_memory').at(-1);
    expect((globalWrite?.args.metadata as Record<string, unknown>).namespace).toBe(GLOBAL_NS);
    expect(server.callsTo('delete_memory').length).toBeGreaterThan(0);
    expect(server.store.filter((record) => record.namespace === BRANCH_A_NS)).toHaveLength(0);

    const globalRecall = await bridge.recall({ scope: branchScope('s-1', 'b-2'), text: 'tool argument validation' });
    expect(globalRecall.positiveLessons.map((lesson) => lesson.id)).toEqual(['L-1']);
  });

  it('degrades deterministically when no MCP memory driver is bound', async () => {
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [], now: () => FIXED_NOW });
    const descriptor = await bridge.initialize();
    expect(descriptor.driverKind).toBe('unbound');
    expect(descriptor.serverId).toBeNull();
    expect(descriptor.capabilities.namespaces).toBe(false);

    const recall = await bridge.recall({ scope: { kind: 'global' }, text: 'anything' });
    expect(recall.degraded).toBe(true);
    expect(recall.confidence).toBe(0);
    expect(recall.lessons).toEqual([]);
    expect(recall.diagnostics.join(' ')).toContain('no MCP memory driver is bound');

    const commit = await bridge.commit(globalLesson(), { scope: { kind: 'global' } });
    expect(commit.accepted).toBe(false);
    expect(commit.persisted).toBe(false);
    expect(commit.violations.map((violation) => violation.code)).toContain('unsupported_operation');

    const prune = await bridge.prune({ scope: { kind: 'global' } });
    expect(prune).toEqual({ scanned: 0, removedIds: [], dryRun: false });
  });

  it('reports an unbound descriptor before initialize and initializes lazily', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client] });
    expect(bridge.initialized).toBe(false);
    expect(bridge.descriptor.driverKind).toBe('unbound');
    expect(bridge.descriptor.diagnostics.join(' ')).toContain('auto-discovery has not run yet');
    const recall = await bridge.recall({ scope: branchScope(), text: 'x' });
    expect(bridge.initialized).toBe(true);
    expect(recall.driverKind).toBe('vector_fact');
    expect(server.listToolsCalls).toBe(1);
  });

  it('creates deterministic isolated namespaces with an idempotent release', async () => {
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [] });
    const handleA = await bridge.isolate(branchScope('s-1', 'b-1'));
    const handleB = await bridge.isolate(branchScope('s-1', 'b-2'));
    expect(handleA.namespace).toBe(BRANCH_A_NS);
    expect(handleB.namespace).toBe('harness2:branch:s-1:b-2');
    expect(handleA.active).toBe(true);
    await handleA.release();
    await handleA.release();
    expect(handleA.active).toBe(false);
    expect(handleB.active).toBe(true);
    expect(bridge.activeNamespaces()).toEqual(['harness2:branch:s-1:b-2']);
  });

  it('stops touching the backend after dispose', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    await bridge.initialize();
    const before = server.calls.length;
    await bridge.dispose();
    await bridge.dispose();
    expect(bridge.disposed).toBe(true);
    const recall = await bridge.recall({ scope: branchScope(), text: 'x' });
    expect(recall.degraded).toBe(true);
    expect(recall.diagnostics.join(' ')).toContain('disposed');
    const commit = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(commit.accepted).toBe(false);
    expect(server.calls.length).toBe(before);
  });
});

/**
 * A client that ignores options.signal and never settles: the wedged
 * stdio/HTTP backend the deadline exists for.
 */
function neverSettlingClient(serverId: string): McpClient {
  return {
    serverId,
    async listTools(): Promise<readonly McpToolDescriptor[]> {
      return [];
    },
    callTool(): Promise<McpToolCallResult> {
      return new Promise<McpToolCallResult>(() => {
        // Deliberately never settles and ignores the abort signal.
      });
    }
  };
}

describe('MCP call deadline', () => {
  it('rejects at the configured deadline even when the client ignores the signal', async () => {
    const started = Date.now();
    await expect(
      callToolWithTimeout(neverSettlingClient('wedged'), 'search_memory', {}, { timeoutMs: 60 })
    ).rejects.toThrow(/MCP tool "search_memory" timed out after 60ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('swallows the losing call rejection so no unhandled rejection escapes', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    // A holder object keeps the deferred reject observable to the test without
    // tripping flow analysis that assumes a let assigned in a callback stays unset.
    const late: { reject?: (error: Error) => void } = {};
    const lateFailing: McpClient = {
      serverId: 'late',
      async listTools() {
        return [];
      },
      callTool() {
        return new Promise<McpToolCallResult>((_resolve, reject) => {
          late.reject = reject;
        });
      }
    };
    try {
      await expect(
        callToolWithTimeout(lateFailing, 'search_memory', {}, { timeoutMs: 40 })
      ).rejects.toThrow(/timed out/);
      expect(typeof late.reject).toBe('function');
      late.reject?.(new Error('late backend failure'));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects promptly for an already-aborted caller signal and forwards the abort', async () => {
    const caller = new AbortController();
    caller.abort(new Error('caller cancelled'));
    const recorder: { signal?: AbortSignal } = {};
    const client: McpClient = {
      serverId: 'signal-recorder',
      async listTools() {
        return [];
      },
      callTool(_name, _args, callOptions) {
        recorder.signal = callOptions?.signal;
        return new Promise<McpToolCallResult>(() => {
          // Ignores the signal: only the caller-abort race can settle this.
        });
      }
    };
    const started = Date.now();
    await expect(
      callToolWithTimeout(client, 'search_memory', {}, { timeoutMs: 5000, signal: caller.signal })
    ).rejects.toThrow('caller cancelled');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(recorder.signal?.aborted).toBe(true);
  });

  it('rejects promptly when the caller aborts mid-flight, reason or not', async () => {
    const caller = new AbortController();
    const pending = callToolWithTimeout(neverSettlingClient('wedged'), 'search_memory', {}, {
      timeoutMs: 5000,
      signal: caller.signal
    });
    const assertion = expect(pending).rejects.toThrow('caller cancelled');
    caller.abort(new Error('caller cancelled'));
    await assertion;

    const bare = new AbortController();
    bare.abort();
    await expect(
      callToolWithTimeout(neverSettlingClient('wedged'), 'search_memory', {}, {
        timeoutMs: 5000,
        signal: bare.signal
      })
    ).rejects.toBeDefined();
  });

  it('keeps a fast successful call unchanged and clears the deadline timer', async () => {
    vi.useFakeTimers();
    try {
      const fast: McpClient = {
        serverId: 'fast',
        async listTools() {
          return [];
        },
        async callTool() {
          return { content: [{ type: 'text', text: 'ok' }] };
        }
      };
      const before = vi.getTimerCount();
      const result = await callToolWithTimeout(fast, 'search_memory', { q: 'x' }, { timeoutMs: 5000 });
      expect(collectText(result)).toBe('ok');
      // The deadline timer must be cleared on the winning path.
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a client failure unchanged instead of converting it to a timeout', async () => {
    const failing: McpClient = {
      serverId: 'failing',
      async listTools() {
        return [];
      },
      async callTool() {
        throw new Error('backend exploded');
      }
    };
    await expect(
      callToolWithTimeout(failing, 'search_memory', {}, { timeoutMs: 5000 })
    ).rejects.toThrow('backend exploded');
  });

  it('keeps the deadline timer referenced while the call is in flight', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const handles: ReturnType<typeof globalThis.setTimeout>[] = [];
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((...args: Parameters<typeof globalThis.setTimeout>) => {
        const handle = originalSetTimeout(...args);
        handles.push(handle);
        return handle;
      });
    try {
      const pending = callToolWithTimeout(neverSettlingClient('wedged'), 'search_memory', {}, { timeoutMs: 60 });
      // In flight: the deadline timer must be referenced, otherwise a one-shot
      // process could drain its event loop before the deadline fires (code 13).
      expect(handles.length).toBeGreaterThan(0);
      expect(handles.every((handle) => handle.hasRef() === true)).toBe(true);
      await expect(pending).rejects.toThrow(/timed out/);
    } finally {
      spy.mockRestore();
    }
  });

  it('clears the deadline timer on settlement so nothing keeps the loop alive', async () => {
    vi.useFakeTimers();
    try {
      const pending = callToolWithTimeout(neverSettlingClient('wedged'), 'search_memory', {}, { timeoutMs: 1000 });
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects in a one-shot process whose only pending work is the hanging call', () => {
    const directory = mkdtempSync(join(tmpdir(), 't55-deadline-'));
    try {
      const moduleUrl = new URL('../../../src/memory-bridge/spi.ts', import.meta.url).href;
      writeFileSync(
        join(directory, 'one-shot.mjs'),
        [
          "import { callToolWithTimeout } from '" + moduleUrl + "';",
          'const client = {',
          "  serverId: 'one-shot',",
          '  async listTools() { return []; },',
          '  callTool() { return new Promise(() => { /* ignores the signal, never settles */ }); }',
          '};',
          'try {',
          "  await callToolWithTimeout(client, 'search_memory', {}, { timeoutMs: 200 });",
          "  console.log(JSON.stringify({ outcome: 'RESOLVED_UNEXPECTED' }));",
          '} catch (error) {',
          "  console.log(JSON.stringify({ outcome: 'REJECTED', message: String(error && error.message) }));",
          '}',
          ''
        ].join('\n')
      );
      // Node >= 22.6 exposes type stripping behind this flag; newer runtimes have
      // it on by default, so the probe keeps the child working on both.
      const flagProbe = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', 'process.exit(0)'], {
        encoding: 'utf8'
      });
      const strippingArgs = flagProbe.status === 0 ? ['--experimental-strip-types', '--no-warnings'] : [];
      const child = spawnSync(process.execPath, [...strippingArgs, join(directory, 'one-shot.mjs')], {
        encoding: 'utf8',
        timeout: 20_000
      });
      // Pre-fix the child exited 13 (ERR_UNSETTLED_TOPLEVEL_AWAIT) with no output.
      expect(child.status).not.toBe(13);
      expect(child.status).toBe(0);
      const parsed = JSON.parse(String(child.stdout).trim()) as { outcome: string; message: string };
      expect(parsed.outcome).toBe('REJECTED');
      expect(parsed.message).toContain('search_memory');
      expect(parsed.message).toContain('timed out after 200ms');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

