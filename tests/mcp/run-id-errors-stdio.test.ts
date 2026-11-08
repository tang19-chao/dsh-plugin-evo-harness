/**
 * REAL stdio regression: unknown runIds use the same error contract through
 * evo_status and evo_run_poll. The child executes the actual src/mcp/server.ts
 * entry bundled by esbuild; the test speaks JSON-RPC over its stdin/stdout.
 * No model request, gateway, key, DSH process, or shared data directory is used.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { EVO_TOOL_NAMES } from '../../src/mcp/server';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(import.meta.url);
const trackedDirs: string[] = [];

afterAll(async () => {
  for (const dir of trackedDirs.splice(0, trackedDirs.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

interface RpcReply {
  readonly result?: Record<string, any>;
  readonly error?: unknown;
}

interface StdioClient {
  readonly call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
  readonly tools: () => Promise<string[]>;
  readonly close: () => Promise<void>;
}

async function startRealServer(): Promise<StdioClient> {
  const esbuild = require_(path.join(repoRoot, 'node_modules', 'esbuild')) as {
    buildSync: (options: Record<string, unknown>) => unknown;
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'evo-mcp-unknown-run-id-'));
  trackedDirs.push(dir);
  const entry = path.join(dir, 'server.js');
  esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'src', 'mcp', 'server.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: entry,
    sourcemap: 'external',
    logLevel: 'silent'
  });
  const dataDir = path.join(dir, 'data');
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      EVO_HARNESS_DATA_DIR: dataDir,
      DSH_DATA_DIR: '',
      DSH_PROFILE: ''
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  let stderr = '';
  const pending = new Map<number, { resolve: (reply: RpcReply) => void; timer: NodeJS.Timeout }>();
  const exit = new Promise<number | string>((resolve) => child.on('exit', (code) => resolve(code ?? 'signal')));
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += String(chunk);
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          const reply = JSON.parse(line) as RpcReply & { id?: number };
          if (reply.id !== undefined) {
            const waiter = pending.get(reply.id);
            if (waiter !== undefined) {
              pending.delete(reply.id);
              clearTimeout(waiter.timer);
              waiter.resolve(reply);
            }
          }
        } catch {
          // A non-protocol stdout line would make the next request fail loudly.
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += String(chunk);
  });
  let seq = 0;
  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, any>> =>
    new Promise((resolve, reject) => {
      seq += 1;
      const id = seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('stdio request timed out: ' + method + '; stderr=' + stderr));
      }, 15_000);
      pending.set(id, {
        timer,
        resolve: (reply) => {
          if (reply.error !== undefined) {
            reject(new Error(method + ' JSON-RPC error: ' + JSON.stringify(reply.error)));
            return;
          }
          resolve(reply.result ?? {});
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'unknown-run-id-stdio-test', version: '0.0.0' }
  });
  expect(initialized.serverInfo?.name).toBe('evo');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    call: (name, args) => request('tools/call', { name, arguments: args }),
    tools: async () => {
      const listed = await request('tools/list', {});
      return (listed.tools as { name: string }[]).map((tool) => tool.name);
    },
    close: async () => {
      child.stdin.end();
      const code = await Promise.race([
        exit,
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 15_000))
      ]);
      if (code !== 0) {
        child.kill();
        throw new Error('real stdio server did not exit cleanly: ' + String(code) + '; stderr=' + stderr);
      }
    }
  };
}

describe('unknown runId over REAL stdio', () => {
  it('evo_status and evo_run_poll both return redacted unknown_run_id errors; all seven tools remain registered', async () => {
    const client = await startRealServer();
    try {
      expect((await client.tools()).sort()).toEqual([...EVO_TOOL_NAMES].sort());
      const runId = 'missing-stdio-run Bearer sk-proj-abcdefgh1234 password=hunter2sensitive';
      const status = await client.call('evo_status', { runId });
      const poll = await client.call('evo_run_poll', { runId });
      expect(status.isError).toBe(true);
      expect(poll.isError).toBe(true);
      expect(status.structuredContent).toEqual(poll.structuredContent);
      for (const reply of [status, poll]) {
        expect(reply.structuredContent.ok).toBe(false);
        expect(reply.structuredContent.code).toBe('unknown_run_id');
        expect(reply.structuredContent.message).toContain('restart');
        const structured = JSON.stringify(reply.structuredContent);
        const text = String(reply.content[0]?.text);
        for (const surface of [structured, text]) {
          expect(surface).not.toContain('sk-proj-abcdefgh1234');
          expect(surface).not.toContain('hunter2sensitive');
          expect(surface).toContain('<secret>');
        }
      }
    } finally {
      await client.close();
    }
  }, 60_000);
});
