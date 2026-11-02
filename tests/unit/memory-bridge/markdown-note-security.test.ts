/**
 * SEC-1/SEC-2 regression tests for the markdown-note driver (cross-audit §6).
 *
 * SEC-1: a lesson id parsed from a backend document trailer used to reach the
 * MCP write/delete path verbatim. Ids bearing path separators or traversal
 * segments must be denied (no write_note/delete_note call, blocking violation
 * or skipped prune) instead of escaping the namespace directory.
 * SEC-2: the recall fingerprint is raw task text; when build_context is bound
 * the value forwarded as `args.url` must be scheme-checked and length-capped.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryBridge } from '../../../src/memory-bridge/bridge';
import {
  buildContextUrlFrom,
  lessonIdToken,
  notePath
} from '../../../src/memory-bridge/drivers/markdown-note.driver';
import type { McpToolDescriptor } from '../../../src/memory-bridge/spi';
import { createMockServer } from './mocks/mock-mcp';
import type { MockServer } from './mocks/mock-mcp';
import { markdownNoteServer } from './mocks/mock-mcp';
import { BRANCH_A_NS, FIXED_NOW, branchScope, memoryConfig, validLesson } from './fixtures';

/** Markdown-note tool set whose recall binds build_context (search_notes absent). */
function buildContextServer(): MockServer {
  const tools: McpToolDescriptor[] = [
    {
      name: 'build_context',
      description: 'assemble context for a memory url',
      inputSchema: { properties: { url: { type: 'string' } } }
    },
    {
      name: 'write_note',
      description: 'write a markdown note',
      inputSchema: { properties: { path: { type: 'string' }, content: { type: 'string' } } }
    },
    { name: 'delete_note', inputSchema: { properties: { path: { type: 'string' } } } }
  ];
  return createMockServer(tools, {
    build_context: () => ({ notes: [] }),
    write_note: () => ({ ok: true }),
    delete_note: () => ({ deleted: true })
  });
}

describe('SEC-1: lesson id containment in note paths', () => {
  it('keeps whitelist-safe ids verbatim (pinned path form)', () => {
    expect(notePath(BRANCH_A_NS, 'L-1')).toBe('harness2/branch/s-1/b-1/L-1.md');
    expect(notePath('ns', 'rendered-0123abcd')).toBe('ns/rendered-0123abcd.md');
  });

  it('rejects ids carrying path separators or a traversal segment', () => {
    expect(lessonIdToken('../../../victim')).toBeUndefined();
    expect(lessonIdToken('a/b')).toBeUndefined();
    expect(lessonIdToken('a\\b')).toBeUndefined();
    expect(lessonIdToken('..')).toBeUndefined();
    expect(lessonIdToken('a..b')).toBeUndefined();
    expect(lessonIdToken('')).toBeUndefined();
    expect(() => notePath(BRANCH_A_NS, '../../../victim')).toThrow(/traversal/);
  });

  it('collapses remaining characters outside the file-token whitelist', () => {
    expect(lessonIdToken('L 1')).toBe('L_1');
    expect(lessonIdToken('title:with#odds')).toBe('title_with_odds');
  });

  it('denies a backend-planted traversal id on write instead of writing it', async () => {
    const server = markdownNoteServer({ serverId: 'basic_memory' });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    await bridge.initialize();
    const result = await bridge.commit(validLesson({ id: '../../victim' }), { scope: branchScope() });
    expect(result.accepted).toBe(false);
    expect(result.persisted).toBe(false);
    const violation = result.violations.find((entry) => entry.code === 'invalid_lesson');
    expect(violation?.severity).toBe('block');
    expect(violation?.message).toContain('traversal');
    expect(server.callsTo('write_note')).toHaveLength(0);
  });

  it('denies a backend-planted traversal id on prune and deletes only safe ids', async () => {
    const server = markdownNoteServer({
      serverId: 'basic_memory',
      seed: [
        { lesson: validLesson({ id: 'L-ok', createdAt: FIXED_NOW - 10_000 }), namespace: BRANCH_A_NS },
        { lesson: validLesson({ id: '../../victim', createdAt: FIXED_NOW - 20_000 }), namespace: BRANCH_A_NS }
      ]
    });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    await bridge.initialize();
    const pruned = await bridge.prune({ scope: branchScope() });
    expect(pruned.scanned).toBe(2);
    expect(pruned.removedIds).toEqual(['L-ok']);
    const deletes = server.callsTo('delete_note');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.args.path).toBe('harness2/branch/s-1/b-1/L-ok.md');
  });
});

describe('SEC-2: build_context url hardening', () => {
  it('strips non-memory URL schemes and caps the forwarded fingerprint', () => {
    expect(buildContextUrlFrom('http://169.254.169.254/latest/meta-data')).toBe('169.254.169.254/latest/meta-data');
    expect(buildContextUrlFrom('file:///etc/passwd')).toBe('etc/passwd');
    expect(buildContextUrlFrom('memory://notes/alpha')).toBe('memory://notes/alpha');
    expect(buildContextUrlFrom('fix the login bug: retry with the pinned signature')).toBe(
      'fix the login bug: retry with the pinned signature'
    );
    expect(buildContextUrlFrom('x'.repeat(600))).toHaveLength(512);
  });

  it('binds the sanitized url when auto-discovery picks build_context', async () => {
    const server = buildContextServer();
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    const descriptor = await bridge.initialize();
    expect(descriptor.driverKind).toBe('markdown_note');
    await bridge.recall({ scope: branchScope(), text: 'http://169.254.169.254/latest/meta-data' });
    const call = server.lastCall('build_context');
    expect(call).toBeDefined();
    expect(call?.args.url).toBe('169.254.169.254/latest/meta-data');
  });
});
