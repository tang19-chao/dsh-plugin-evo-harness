/**
 * Virtual namespace isolation and the post-recall negative firewall.
 * These tests deliberately use namespace-blind mocks to prove the isolation is
 * enforced client-side, not by the backend.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryBridge } from '../../../src/memory-bridge/bridge';
import { applyPostRecallFirewall, clauseMatchesContext, tokenizeContext } from '../../../src/memory-bridge/governance-polyfill';
import { deriveNamespace, visibleNamespaces } from '../../../src/memory-bridge/namespace';
import { graphEntityServer, vectorFactServer } from './mocks/mock-mcp';
import {
  BRANCH_A_NS,
  BRANCH_B_NS,
  FIXED_NOW,
  GLOBAL_NS,
  SESSION,
  branchScope,
  memoryConfig,
  negativeLesson,
  validLesson
} from './fixtures';

describe('deterministic virtual namespaces', () => {
  it('derives one stable namespace per scope', () => {
    expect(deriveNamespace(branchScope(), 'harness2')).toBe(BRANCH_A_NS);
    expect(deriveNamespace(branchScope('s-1', 'b-2'), 'harness2')).toBe(BRANCH_B_NS);
    expect(deriveNamespace({ kind: 'session', sessionId: SESSION }, 'harness2')).toBe('harness2:session:s-1');
    expect(deriveNamespace({ kind: 'global' }, 'harness2')).toBe(GLOBAL_NS);
    expect(deriveNamespace(branchScope(), 'harness2')).toBe(deriveNamespace(branchScope(), 'harness2'));
  });

  it('escapes unsafe scope segments without collapsing distinct ids', () => {
    const slash = deriveNamespace({ kind: 'branch', sessionId: 's/1', branchId: 'b:2' }, 'harness2');
    const colon = deriveNamespace({ kind: 'branch', sessionId: 's:1', branchId: 'b/2' }, 'harness2');
    expect(slash).toBe(deriveNamespace({ kind: 'branch', sessionId: 's/1', branchId: 'b:2' }, 'harness2'));
    expect(slash).not.toBe(colon);
  });

  it('lists only the namespaces a scope may read', () => {
    expect(visibleNamespaces(branchScope(), 'harness2')).toEqual([
      BRANCH_A_NS,
      'harness2:session:s-1',
      GLOBAL_NS
    ]);
    expect(visibleNamespaces(branchScope('s-1', 'b-2'), 'harness2')).not.toContain(BRANCH_A_NS);
    expect(visibleNamespaces({ kind: 'global' }, 'harness2')).toEqual([GLOBAL_NS]);
  });
});

describe('branch isolation', () => {
  it('hides branch-private writes from sibling branches on a namespace-blind backend', async () => {
    const server = graphEntityServer({ serverId: 'official_kg' });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    const commit = await bridge.commit(validLesson({ id: 'L-A' }), { scope: branchScope('s-1', 'b-1') });
    expect(commit.accepted).toBe(true);
    expect(commit.namespace).toBe(BRANCH_A_NS);

    const sibling = await bridge.recall({ scope: branchScope('s-1', 'b-2'), text: 'unrelated task' });
    expect(sibling.lessons).toEqual([]);
    expect(sibling.positiveLessons).toEqual([]);
    expect(sibling.suppressedLessons.map((entry) => entry.reason)).toContain('scope_mismatch');
    expect(sibling.suppressedLessons[0]?.detail).toContain('another branch');

    const own = await bridge.recall({ scope: branchScope('s-1', 'b-1'), text: 'unrelated task' });
    expect(own.positiveLessons.map((lesson) => lesson.id)).toEqual(['L-A']);
  });

  it('enforces the same isolation when a backend ignores namespace filters', async () => {
    const server = vectorFactServer({ serverId: 'mem0', enforceNamespace: false });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    await bridge.commit(validLesson({ id: 'L-A' }), { scope: branchScope('s-1', 'b-1') });
    const sibling = await bridge.recall({ scope: branchScope('s-1', 'b-2'), text: 'unrelated task' });
    expect(sibling.lessons).toEqual([]);
    expect(sibling.suppressedLessons.map((entry) => entry.reason)).toContain('scope_mismatch');
  });

  it('promotes the winning lesson to global without cross-branch leakage', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    const lesson = validLesson({ id: 'L-A' });
    await bridge.commit(lesson, { scope: branchScope('s-1', 'b-1') });
    expect((await bridge.recall({ scope: branchScope('s-1', 'b-2'), text: 'task' })).lessons).toEqual([]);

    const promoted = await bridge.promote(lesson, { from: branchScope('s-1', 'b-1') });
    expect(promoted.accepted).toBe(true);
    expect(promoted.namespace).toBe(GLOBAL_NS);
    expect(server.store.filter((record) => record.namespace === BRANCH_A_NS)).toHaveLength(0);
    expect(server.store.filter((record) => record.namespace === GLOBAL_NS)).toHaveLength(1);

    const sibling = await bridge.recall({ scope: branchScope('s-1', 'b-2'), text: 'task' });
    expect(sibling.positiveLessons.map((entry) => entry.id)).toEqual(['L-A']);
    expect(sibling.positiveLessons[0]?.visibility).toBe('global');
    expect(sibling.positiveLessons[0]?.branchId).toBeUndefined();
    expect(sibling.positiveLessons[0]?.metadata?.promotedFrom).toBe(BRANCH_A_NS);
  });

  it('refuses to promote an incomplete lesson', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    const promoted = await bridge.promote(validLesson({ whenNotToApply: [] }), { from: branchScope() });
    expect(promoted.accepted).toBe(false);
    expect(promoted.violations.map((violation) => violation.code)).toContain('missing_when_not_to_apply');
    expect(server.calls).toHaveLength(0);
  });
});

describe('negative firewall', () => {
  it('vetoes lessons whose whenNotToApply matches the task context', async () => {
    const lesson = validLesson({ id: 'L-veto', whenNotToApply: ['offline sandbox unavailable'] });
    const server = graphEntityServer({
      serverId: 'official_kg',
      seed: [{ lesson, namespace: BRANCH_A_NS }]
    });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });

    const vetoed = await bridge.recall({
      scope: branchScope(),
      text: 'the offline sandbox is unavailable so we cannot verify'
    });
    expect(vetoed.lessons).toEqual([]);
    const suppression = vetoed.suppressedLessons[0];
    expect(suppression?.reason).toBe('when_not_to_apply');
    expect(suppression?.detail).toContain('offline sandbox unavailable');

    const allowed = await bridge.recall({ scope: branchScope(), text: 'a completely unrelated refactor' });
    expect(allowed.positiveLessons.map((entry) => entry.id)).toEqual(['L-veto']);
  });

  it('skips the veto when the firewall is disabled by configuration', async () => {
    const lesson = validLesson({ id: 'L-veto', whenNotToApply: ['offline sandbox unavailable'] });
    const server = graphEntityServer({
      serverId: 'official_kg',
      seed: [{ lesson, namespace: BRANCH_A_NS }]
    });
    const bridge = createMemoryBridge({
      config: memoryConfig({ enableNegativeFirewall: false }),
      clients: [server.client],
      now: () => FIXED_NOW
    });
    const recall = await bridge.recall({
      scope: branchScope(),
      text: 'the offline sandbox is unavailable so we cannot verify'
    });
    expect(recall.positiveLessons.map((entry) => entry.id)).toEqual(['L-veto']);
    expect(recall.diagnostics.join(' ')).toContain('negative firewall disabled');
  });

  it('separates negative failure lessons from positive recommendations', async () => {
    const server = graphEntityServer({
      serverId: 'official_kg',
      seed: [
        { lesson: validLesson({ id: 'L-pos' }), namespace: BRANCH_A_NS },
        { lesson: negativeLesson({ id: 'L-neg' }), namespace: BRANCH_A_NS }
      ]
    });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    const recall = await bridge.recall({ scope: branchScope(), text: 'a large tool schema question' });
    expect(recall.positiveLessons.map((entry) => entry.id)).toEqual(['L-pos']);
    expect(recall.negativeLessons.map((entry) => entry.id)).toEqual(['L-neg']);
    expect(recall.lessons).toHaveLength(
      recall.positiveLessons.length + recall.negativeLessons.length
    );
    expect(recall.positiveLessons.some((entry) => entry.polarity === 'negative')).toBe(false);
    expect(recall.confidence).toBeCloseTo(0.9, 6);
  });

  it('withholds negatives entirely when includeNegative is false', async () => {
    const server = graphEntityServer({
      serverId: 'official_kg',
      seed: [{ lesson: negativeLesson({ id: 'L-neg' }), namespace: BRANCH_A_NS }]
    });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    const recall = await bridge.recall({ scope: branchScope(), text: 'a large tool schema question', includeNegative: false });
    expect(recall.negativeLessons).toEqual([]);
    expect(recall.lessons).toEqual([]);
    expect(recall.suppressedLessons.map((entry) => entry.reason)).toContain('negative_polarity_filtered');
    expect(recall.confidence).toBe(0);
  });

  it('drops lessons below the requested confidence floor', async () => {
    const server = graphEntityServer({
      serverId: 'official_kg',
      seed: [{ lesson: validLesson({ id: 'L-low', confidence: 0.2 }), namespace: BRANCH_A_NS }]
    });
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
    const recall = await bridge.recall({ scope: branchScope(), text: 'refactor', minConfidence: 0.5 });
    expect(recall.lessons).toEqual([]);
    expect(recall.suppressedLessons.map((entry) => entry.reason)).toContain('low_confidence');
  });

  it('treats a CJK restraint clause by run containment', () => {
    const context = tokenizeContext('现在处于离线沙箱环境，无法联网验证');
    expect(clauseMatchesContext('离线沙箱不可用时', context)).toBe(true);
    expect(clauseMatchesContext('仅适用于大型代码库', context)).toBe(false);
  });

  it('exposes the firewall outcome as pure data', () => {
    const query = { scope: branchScope(), text: 'offline sandbox unavailable' };
    const outcome = applyPostRecallFirewall({
      records: [{ lesson: validLesson({ whenNotToApply: ['offline sandbox unavailable'] }), namespace: BRANCH_A_NS }],
      query,
      scope: branchScope(),
      config: memoryConfig(),
      minConfidence: 0
    });
    expect(outcome.lessons).toEqual([]);
    expect(outcome.suppressedLessons).toHaveLength(1);
    expect(outcome.confidence).toBe(0);
  });
});
