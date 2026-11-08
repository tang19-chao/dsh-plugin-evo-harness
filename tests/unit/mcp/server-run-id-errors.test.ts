/**
 * Direct tool-handler regression for the shared unknown-runId error contract.
 *
 * The assertions invoke the callbacks returned by McpServer.registerTool, not
 * a transport and not a reimplementation of either handler. The production
 * model is never called: both tools only inspect the in-memory job book.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createEvoMcpServer, EVO_TOOL_NAMES } from '../../../src/mcp/server';
import { cleanupDir, makeTempDir } from '../persistence/fixtures';

interface DirectTool {
  readonly handler: (args: Record<string, unknown>, context: unknown) => Promise<any>;
}

interface ToolRegistry {
  readonly _registeredTools: Record<string, DirectTool>;
}

interface ToolReply {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly structuredContent: Record<string, any>;
}

const tempDirs: string[] = [];
const instances: ReturnType<typeof createEvoMcpServer>[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0, instances.length)) {
    await instance.dispose();
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await cleanupDir(dir).catch(() => {});
  }
});

async function directServer(): Promise<{
  readonly call: (name: string, args: Record<string, unknown>) => Promise<ToolReply>;
  readonly registry: ToolRegistry;
}> {
  const dataDir = await makeTempDir('mcp-direct-run-id');
  tempDirs.push(dataDir);
  const instance = createEvoMcpServer({
    assembly: {
      config: { logging: { level: 'silent' } },
      dataDir: { dataDir, env: { EVO_HARNESS_DATA_DIR: undefined, DSH_DATA_DIR: undefined, DSH_PROFILE: undefined } }
    }
  });
  instances.push(instance);
  await instance.ready;
  const registry = instance.server as unknown as ToolRegistry;
  return {
    registry,
    call: async (name, args) => registry._registeredTools[name]!.handler(args, {})
  };
}

function expectUnknownRunId(reply: ToolReply, runId: string): void {
  expect(reply.isError).toBe(true);
  expect(reply.structuredContent.ok).toBe(false);
  expect(reply.structuredContent.code).toBe('unknown_run_id');
  expect(reply.structuredContent.runId).toBe(runId);
  expect(reply.structuredContent.message).toContain('restart');
  expect(reply.content[0]?.text).toContain('unknown_run_id');
}

describe('direct unknown-runId tool contract', () => {
  it('evo_status and evo_run_poll preserve the job-book unknown_run_id code identically', async () => {
    const { call } = await directServer();
    const runId = 'missing-direct-run';
    const status = await call('evo_status', { runId });
    const poll = await call('evo_run_poll', { runId });
    expectUnknownRunId(status, runId);
    expectUnknownRunId(poll, runId);
    expect(status.structuredContent).toEqual(poll.structuredContent);
    expect(status.content).toEqual(poll.content);
  });

  it('redacts a secret-shaped unknown runId in BOTH error surfaces', async () => {
    const { call } = await directServer();
    const runId = 'missing Bearer sk-proj-abcdefgh1234 password=hunter2sensitive';
    for (const name of ['evo_status', 'evo_run_poll'] as const) {
      const reply = await call(name, { runId });
      expect(reply.isError).toBe(true);
      expect(reply.structuredContent.code).toBe('unknown_run_id');
      const serialized = JSON.stringify(reply.structuredContent);
      expect(serialized).not.toContain('sk-proj-abcdefgh1234');
      expect(serialized).not.toContain('hunter2sensitive');
      expect(serialized).toContain('<secret>');
      expect(reply.content[0]?.text).not.toContain('sk-proj-abcdefgh1234');
      expect(reply.content[0]?.text).not.toContain('hunter2sensitive');
      expect(reply.content[0]?.text).toContain('<secret>');
    }
  });

  it('redacts structuredContent from all seven tools when their arguments contain secret shapes', async () => {
    const { call } = await directServer();
    const secret = 'sk-proj-abcdefgh1234';
    const cases: readonly [string, Record<string, unknown>][] = [
      ['evo_status', { runId: 'missing-' + secret }],
      ['evo_run_submit', { prompt: 'preview ' + secret, dryRun: true }],
      ['evo_run_poll', { runId: 'missing-' + secret }],
      ['evo_dream', { diagnostics: 'diagnostic ' + secret }],
      ['evo_jit', { action: 'status', bucket: 'bucket-' + secret }],
      ['evo_lessons', { limit: 1 }],
      ['evo_text_probe', { prompt: 'probe ' + secret }]
    ];
    for (const [name, args] of cases) {
      const reply = await call(name, args);
      expect(reply.structuredContent, name).toBeDefined();
      expect(JSON.stringify(reply.structuredContent), name).not.toContain(secret);
    }
  });

  it('leaves the exact seven-tool registry unchanged', async () => {
    const { registry } = await directServer();
    expect(Object.keys(registry._registeredTools).sort()).toEqual([...EVO_TOOL_NAMES].sort());
    expect(Object.keys(registry._registeredTools)).toHaveLength(7);
  });
});
