#!/usr/bin/env node
/**
 * Offline stdio MCP fixture AND its desktop-shaped patch selector.
 *
 * Patch writer mode (default): writes a temp cordis.patch.yml that mirrors the
 * deployed template's shape (- insert entry, @deepseek-ai/dsh-mcp-client,
 * stdio, env, reconnect) pointing at THIS file as the server.
 *
 * Server mode (--serve): spawned by the INSTALLED dsh-mcp-client during the
 * probe self-test. Speaks real JSON-RPC 2.0 over stdio. Synthetic status only;
 * never imports the evo server, reads a key, opens a network listener or
 * writes data (the pidfile below records its own pid so the self-test can
 * prove the transport teardown reaped the child).
 *
 * Behaviour is selected by REV8_HOST_PROBE_INPUT.evidenceKind (propagated via
 * a `!!js` env value, exactly like the deployed template's key-fallback line):
 *   success       one evo_status tool with shadow / applyWinningPatch=false
 *   missing-tool  tools/list omits evo_status
 *   tool-error    evo_status returns isError=true
 *   timeout       evo_status never replies; the SDK call timeout must surface
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(import.meta.url);
// NOTE: the probe does NOT evaluate !!js expressions (it passes the literal
// string through), so the scenario travels in a PLAIN env value; the !!js
// REV8_HOST_PROBE_INPUT line only proves the probe's parser tolerates the tag.
const scenario = process.env.REV8_FIXTURE_SCENARIO ?? 'offline-success';
const tool = {
  name: 'evo_status',
  description: 'synthetic offline status',
  inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, additionalProperties: false }
};

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function handle(request) {
  const { id, method, params = {} } = request;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'rev8-offline-fixture', version: '1.0.0' },
        instructions: 'synthetic offline fixture for the rev8 host probe self-test'
      }
    });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: scenario === 'offline-missing-tool' ? [] : [tool] } });
  } else if (method === 'tools/call' && params.name === 'evo_status') {
    if (scenario === 'offline-timeout') return; // never replies: exercises the SDK call timeout
    const result = scenario === 'offline-tool-error'
      ? { content: [{ type: 'text', text: 'synthetic offline tool failure' }], isError: true }
      : {
          content: [{ type: 'text', text: '{"status":"offline"}' }],
          structuredContent: { payload: { status: 'offline', execution: { mode: 'shadow', applyWinningPatch: false } } },
          isError: false
        };
    send({ jsonrpc: '2.0', id, result });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (method !== 'notifications/initialized') {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported fixture method: ${method}` } });
  }
}

function serve() {
  const pidFile = process.env.REV8_FIXTURE_PIDFILE;
  if (pidFile) {
    try { fs.writeFileSync(pidFile, String(process.pid)); } catch { /* best effort only */ }
  }
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    try {
      handle(JSON.parse(line));
    } catch (error) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error instanceof Error ? error.message : 'fixture parse error' } });
    }
  });
  rl.on('close', () => { process.exitCode = 0; });
}

function writePatch(profilePath, scenarioName) {
  const scenario = scenarioName ?? 'offline-success';
  const command = JSON.stringify(process.execPath);
  const script = JSON.stringify(fixturePath);
  const pidFile = profilePath + '.fixture.pid';
  const text = [
    '# generated in the OS temp directory by the rev8 host probe self-test;',
    '# no desktop file is edited. Shape mirrors the deployed mcp-evo template:',
    '# a `- insert:` list item — a bare top-level `- id:` never activates a',
    '# built-in package name (rev8 plan §5.5), so the deployed shape is insert.',
    '- insert:',
    '    - id: mcp-evo',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: evo',
    '        transport: stdio',
    `        command: ${command}`,
    `        args: [${script}, '--serve']`,
    `        cwd: ${JSON.stringify(path.dirname(fixturePath))}`,
    '        env:',
    `          REV8_FIXTURE_PIDFILE: ${JSON.stringify(pidFile)}`,
    `          REV8_FIXTURE_SCENARIO: ${JSON.stringify(scenario)}`,
    `          REV8_HOST_PROBE_INPUT: !!js "process.env.REV8_HOST_PROBE_INPUT ?? ''"`,
    '        toolCallTimeoutMs: 2500',
    '        failOnStartupError: true',
    '        maxInstructionBytes: 32768',
    '        reconnect:',
    '          enabled: false',
    '          initialDelayMs: 500',
    '          maxDelayMs: 30000',
    '          maxAttempts: 1'
  ].join('\n') + '\n';
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, text, { flag: 'wx' });
}

if (process.argv.includes('--serve')) serve();
else writePatch(process.argv[2], process.argv[3]);
