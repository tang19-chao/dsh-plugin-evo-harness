#!/usr/bin/env node
/**
 * MCP backend fixture (P6.1-F, doc §9.3 "单一 MCP 后端").
 *
 * A real Model Context Protocol server speaking JSON-RPC 2.0 over stdio, so the
 * single-backend smoke exercises an actual transport (framing, request ids, tool
 * discovery, error results) rather than a hand-written client double.
 *
 * Why a fixture backend instead of a product backend: the task requires the
 * *smoke* to be real, not the business data. This server owns no user data, its
 * namespace is a test namespace, and it deliberately exposes the failure shapes
 * the security contract cares about:
 *   - a write tool whose schema mirrors the memory-bridge write surface;
 *   - a rejection that carries a CANARY body, to prove the mirror never echoes it;
 *   - a tool that sleeps past the client deadline, to prove the timeout path;
 *   - a call counter, so "off means zero further backend calls" is measurable.
 *
 * Plain JavaScript on purpose: this process is spawned directly (no bundler), so
 * it must be valid Node ESM as-is.
 */
import readline from 'node:readline';

const CANARY_ENV = 'HOSTSMOKE_CANARY';
const canary = process.env[CANARY_ENV] ?? 'HOSTSMOKE-CANARY-DEFAULT';

/** Tool list the smoke discovers; names mirror the real recall/write surface. */
const TOOLS = [
  {
    name: 'search_memory',
    description: 'Search stored notes (test backend).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
  },
  {
    name: 'write_note',
    description: 'Write one note (test backend).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        path: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object' }
      },
      required: ['text']
    }
  },
  {
    name: 'hostsmoke_fail_with_canary',
    description: 'Always fails with a canary-bearing body (test backend).',
    inputSchema: { type: 'object', properties: { probe: { type: 'string' } } }
  },
  {
    name: 'hostsmoke_slow',
    description: 'Sleeps past the client deadline (test backend).',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } } }
  },
  {
    name: 'hostsmoke_call_count',
    description: 'Reports how many tools/call requests this process served.',
    inputSchema: { type: 'object', properties: {} }
  }
];

/** State the smoke reads back (counts and test rows only, never user data). */
const state = {
  calls: 0,
  writes: [],
  /** Rows written through write_note, keyed by their text, for idempotence. */
  writeKeys: new Set()
};

function textResult(text) {
  return { content: [{ type: 'text', text }], isError: false };
}

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callTool(name, args) {
  // The counter tool deliberately does NOT count itself: the smoke measures
  // "a disabled mirror makes zero backend calls" by reading the counter before
  // and after, and a self-counting reader would add 1 to its own delta.
  if (name !== 'hostsmoke_call_count') {
    state.calls += 1;
  }
  switch (name) {
    case 'search_memory': {
      const query = typeof args['query'] === 'string' ? args['query'] : '';
      return jsonResult({
        results: state.writes
          .filter((write) => query.length === 0 || write.text.includes(query))
          .map((write, index) => ({ id: 'note-' + String(index + 1), text: write.text }))
      });
    }
    case 'write_note': {
      const text = typeof args['text'] === 'string' ? args['text'] : '';
      if (text.length === 0) {
        // A rejected-body path: the client must degrade without echoing this.
        return errorResult('write_note requires non-empty text: ' + canary);
      }
      // Deliberate canary-bearing rejection: the aggregate text carries the
      // canary and the backend rejects it with an error body containing the
      // canary, so any echo in a diagnostic would be provable.
      if (text.includes(canary)) {
        return errorResult('backend rejected payload containing ' + canary + ' (echo probe)');
      }
      const key = text;
      if (state.writeKeys.has(key)) {
        return jsonResult({ written: 0, duplicate: true, key });
      }
      state.writeKeys.add(key);
      state.writes.push({
        text,
        ...(typeof args['path'] === 'string' ? { path: args['path'] } : {}),
        ...(Array.isArray(args['tags'])
          ? { tags: args['tags'].filter((tag) => typeof tag === 'string') }
          : {})
      });
      return jsonResult({ written: 1, duplicate: false, key });
    }
    case 'hostsmoke_fail_with_canary': {
      return errorResult('smoke failure body canary=' + canary);
    }
    case 'hostsmoke_slow': {
      const ms = typeof args['ms'] === 'number' && Number.isFinite(args['ms']) ? args['ms'] : 2000;
      await sleep(ms);
      return textResult('slept ' + String(ms));
    }
    case 'hostsmoke_call_count': {
      return jsonResult({ calls: state.calls, writes: state.writes.length });
    }
    default:
      return errorResult('unknown tool ' + name);
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(request) {
  const id = request['id'];
  const method = typeof request['method'] === 'string' ? request['method'] : '';
  const params = request['params'] ?? {};
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion:
          typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hostsmoke-mcp-fixture', version: '1.0.0' }
      }
    });
    return;
  }
  if (method === 'notifications/initialized') {
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const args = params['arguments'] ?? {};
    const result = await callTool(name, args);
    send({ jsonrpc: '2.0', id, result });
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  void handle(parsed).catch((error) => {
    send({
      jsonrpc: '2.0',
      id: parsed['id'],
      error: { code: -32000, message: error instanceof Error ? error.name : 'internal error' }
    });
  });
});
