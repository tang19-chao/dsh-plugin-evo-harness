/**
 * Regression tests for the CROSS-AUDIT-REPORT §6 memory/seams residual items
 * (MEM-2/3/4/8/9/10). Each test pins the exact failure the second-round audit
 * reproduced, so the fix cannot silently regress into the old shape.
 */

import { describe, expect, it } from 'vitest';

import type { CanonicalLesson, MemoryCommitOptions } from '../../../src/types/contracts';
import { createMemoryBridge } from '../../../src/memory-bridge/bridge';
import { createDriverContext } from '../../../src/memory-bridge/auto-discovery';
import { declaredPropertyType } from '../../../src/memory-bridge/drivers/shared';
import {
  parseLessonDocument,
  parseRenderedLesson,
  renderLessonMarkdown,
  serializeLesson
} from '../../../src/memory-bridge/lesson-codec';
import { deriveNamespace, scopeInlineTag, visibleNamespaces } from '../../../src/memory-bridge/namespace';
import type { MemoryDriverContext } from '../../../src/memory-bridge/spi';
import {
  customMappedServer,
  graphEntityServer,
  lingshuServer,
  markdownNoteServer,
  temporalServer,
  vectorFactServer
} from './mocks/mock-mcp';
import type { MockServer } from './mocks/mock-mcp';
import { BRANCH_A_NS, FIXED_NOW, GLOBAL_NS, branchScope, memoryConfig, validLesson } from './fixtures';

function bridgeFor(server: MockServer) {
  return createMemoryBridge({ config: memoryConfig(), clients: [server.client], now: () => FIXED_NOW });
}

async function contextFor(
  server: MockServer,
  tool: string
): Promise<{ readonly context: MemoryDriverContext; readonly declaredType: string | undefined }> {
  const tools = await server.client.listTools();
  const context = createDriverContext(server.client, tools, memoryConfig(), { recall: tool, commit: tool }, () => FIXED_NOW);
  return { context, declaredType: declaredPropertyType(context, tool, 'user_id') };
}

// ---------------------------------------------------------------------------
// MEM-3: branch scope sends a SCALAR namespace filter per declared-scalar field
// ---------------------------------------------------------------------------

describe('MEM-3 scalar namespace filtering (branch scope)', () => {
  it('vector-fact declares user_id as a scalar and sends one scalar per namespace', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const { declaredType } = await contextFor(server, 'search_memory');
    expect(declaredType).toBe('string');

    const bridge = bridgeFor(server);
    await bridge.initialize();
    const recall = await bridge.recall({ scope: branchScope(), text: 'tool argument validation' });
    expect(recall.degraded).toBe(false);

    // A branch scope sees branch + session + global, so three scalar calls —
    // never one call carrying a JSON array into a string-typed field.
    const calls = server.callsTo('search_memory');
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.args.user_id)).toEqual(visibleNamespaces(branchScope(), 'harness2'));
    for (const call of calls) {
      expect(typeof call.args.user_id).toBe('string');
      expect(Array.isArray(call.args.user_id)).toBe(false);
    }
  });

  it('temporal sends a scalar namespace filter per namespace and keeps the array-typed group_ids window', async () => {
    const server = temporalServer({ serverId: 'graphiti' });
    const bridge = bridgeFor(server);
    await bridge.initialize();
    await bridge.recall({ scope: branchScope(), text: 'episode' });

    const calls = server.callsTo('search_facts');
    // search_facts declares no namespace-named scalar (only the array-typed
    // group_ids), so the resolved filter field is the canonical user_id fallback
    // and is carried once per namespace as a SCALAR on that field.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(typeof call.args.user_id).toBe('string');
      expect(Array.isArray(call.args.user_id)).toBe(false);
      // group_ids is genuinely declared as an array, so the full list stays.
      expect(call.args.group_ids).toEqual(visibleNamespaces(branchScope(), 'harness2'));
    }
  });

  it('custom-mapped sends a scalar my_scope per namespace', async () => {
    const server = customMappedServer({ serverId: 'my_custom' });
    const bridge = createMemoryBridge({
      config: memoryConfig({
        customMapping: {
          enabled: true,
          recallToolName: 'my_custom_search',
          commitToolName: 'my_custom_upsert',
          pruneToolName: 'my_custom_purge'
        }
      }),
      clients: [server.client],
      now: () => FIXED_NOW
    });
    await bridge.initialize();
    await bridge.recall({ scope: branchScope(), text: 'anything' });

    const calls = server.callsTo('my_custom_search');
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(typeof call.args.my_scope).toBe('string');
      expect(Array.isArray(call.args.my_scope)).toBe(false);
    }
  });

  it('dedupes a namespace-blind backend that answers every scalar call with the whole store', async () => {
    const server = vectorFactServer({ serverId: 'mem0', enforceNamespace: false });
    const bridge = bridgeFor(server);
    await bridge.initialize();
    await bridge.commit(validLesson(), { scope: branchScope() });

    const recall = await bridge.recall({ scope: branchScope(), text: 'tool argument validation' });
    expect(recall.positiveLessons.map((lesson) => lesson.id)).toEqual(['L-1']);
  });
});

// ---------------------------------------------------------------------------
// MEM-2: the supplemental stg timeline carries the namespace filter
// ---------------------------------------------------------------------------

describe('MEM-2 lingshu timeline fallback is namespace-scoped', () => {
  it('sends a namespace argument on every supplemental stg call and drops foreign results', async () => {
    const foreign = validLesson({ id: 'L-foreign', sessionId: 's-other', branchId: 'b-other' });
    const server = lingshuServer({
      serverId: 'lingshu',
      seed: [
        { lesson: validLesson(), namespace: BRANCH_A_NS },
        { lesson: foreign, namespace: 'harness2:branch:s-other:b-other' }
      ]
    });
    const bridge = bridgeFor(server);
    await bridge.initialize();
    const recall = await bridge.recall({ scope: branchScope(), text: 'tool argument validation' });

    const stgCalls = server.callsTo('stg');
    expect(stgCalls.length).toBeGreaterThan(0);
    for (const call of stgCalls) {
      expect(typeof call.args.namespace).toBe('string');
      expect(String(call.args.namespace).length).toBeGreaterThan(0);
    }
    expect(recall.positiveLessons.map((lesson) => lesson.id)).toEqual(['L-1']);
    // The foreign lesson is filtered by the stg handler's namespace filter (or
    // by the driver's own range check); either way it never reaches the set.
    expect(recall.lessons.map((lesson) => lesson.id)).toEqual(['L-1']);
  });

  it('never runs the unscoped timeline query the audit reproduced', async () => {
    const server = lingshuServer({ serverId: 'lingshu' });
    const bridge = bridgeFor(server);
    await bridge.initialize();
    await bridge.commit(validLesson(), { scope: branchScope() });
    await bridge.recall({ scope: branchScope(), text: 'tool argument validation' });
    const unscoped = server.callsTo('stg').filter((call) => call.args.namespace === undefined);
    expect(unscoped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MEM-4: the lingshu native write/recall roundtrip is lossless
// ---------------------------------------------------------------------------

describe('MEM-4 rendered-form roundtrip (four reproduced corruptions)', () => {
  const lesson: CanonicalLesson = validLesson({
    executionPatch: {
      summary: 'do it\n## 不适用条件 / whenNotToApply\ninjected',
      componentDiffs: { tool_guidance: 'add example\nSecond line kept' }
    },
    verificationEvidence: {
      referenceFailure: 'line one\nline two',
      candidateSuccess: 'ok one\nok two',
      metricsDelta: { stepsDiff: 1.5, toolErrorsDiff: -2.5 }
    },
    whenToApply: ['cue line1\ncue line2'],
    whenNotToApply: ['restraint\nsecond restraint line']
  });

  it('keeps a heading inside summary from injecting a phantom whenNotToApply clause', () => {
    const parsed = parseRenderedLesson(renderLessonMarkdown(lesson));
    expect(parsed).toBeDefined();
    expect(parsed?.lesson.executionPatch.summary).toBe('do it\n## 不适用条件 / whenNotToApply\ninjected');
    expect(parsed?.lesson.whenNotToApply).toEqual(['restraint\nsecond restraint line']);
  });

  it('preserves fractional metricsDelta instead of truncating it', () => {
    const parsed = parseRenderedLesson(renderLessonMarkdown(lesson));
    expect(parsed?.lesson.verificationEvidence.metricsDelta).toEqual({ stepsDiff: 1.5, toolErrorsDiff: -2.5 });
  });

  it('keeps multi-line evidence whole instead of only its first line', () => {
    const parsed = parseRenderedLesson(renderLessonMarkdown(lesson));
    expect(parsed?.lesson.verificationEvidence.referenceFailure).toBe('line one\nline two');
    expect(parsed?.lesson.verificationEvidence.candidateSuccess).toBe('ok one\nok two');
  });

  it('keeps a multi-line cue as one cue instead of splitting it into two', () => {
    const parsed = parseRenderedLesson(renderLessonMarkdown(lesson));
    expect(parsed?.lesson.whenToApply).toEqual(['cue line1\ncue line2']);
  });

  it('round-trips the lingshu native write text through a full bridge commit/recall', async () => {
    const server = lingshuServer({ serverId: 'lingshu' });
    const bridge = bridgeFor(server);
    await bridge.initialize();
    const write = await bridge.commit(lesson, { scope: branchScope() });
    expect(write.accepted).toBe(true);

    const stored = server.store[0]?.text ?? '';
    // The structured form is what gets stored: the frontmatter envelope travels
    // with the white-box text.
    expect(stored).toContain('harness_lesson: 1');
    expect(stored.startsWith(scopeInlineTag(BRANCH_A_NS))).toBe(true);

    const recall = await bridge.recall({ scope: branchScope(), text: 'unrelated refactor' });
    const recovered = recall.positiveLessons[0];
    expect(recovered?.verificationEvidence).toEqual(lesson.verificationEvidence);
    expect(recovered?.executionPatch.summary).toBe(lesson.executionPatch.summary);
    expect(recovered?.executionPatch.componentDiffs).toEqual(lesson.executionPatch.componentDiffs);
    expect(recovered?.whenToApply).toEqual([...lesson.whenToApply]);
    expect(recovered?.whenNotToApply).toEqual([...lesson.whenNotToApply]);
  });

  it('keeps the frontmatter envelope path lossless (control)', () => {
    const parsed = parseLessonDocument(serializeLesson(lesson, { namespace: BRANCH_A_NS }));
    expect(parsed?.lesson.verificationEvidence).toEqual(lesson.verificationEvidence);
    expect(parsed?.lesson.executionPatch).toEqual(lesson.executionPatch);
  });
});

// ---------------------------------------------------------------------------
// MEM-8: a second isolate() over one namespace does not orphan the first handle
// ---------------------------------------------------------------------------

describe('MEM-8 double-handle isolation accounting', () => {
  it('keeps the namespace live until the LAST handle releases', async () => {
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [], now: () => FIXED_NOW });
    const first = await bridge.isolate(branchScope());
    const second = await bridge.isolate(branchScope());
    expect(first.namespace).toBe(deriveNamespace(branchScope(), 'harness2'));
    expect(second.namespace).toBe(first.namespace);
    expect(bridge.activeNamespaces()).toEqual([BRANCH_A_NS]);

    await first.release();
    // The second handle is still live: the accessor must not claim otherwise.
    expect(second.active).toBe(true);
    expect(bridge.activeNamespaces()).toEqual([BRANCH_A_NS]);

    await second.release();
    expect(bridge.activeNamespaces()).toEqual([]);
  });

  it('stays idempotent per handle', async () => {
    const bridge = createMemoryBridge({ config: memoryConfig(), clients: [], now: () => FIXED_NOW });
    const first = await bridge.isolate(branchScope());
    const second = await bridge.isolate(branchScope());
    await first.release();
    await first.release();
    expect(second.active).toBe(true);
    await second.release();
    await second.release();
    expect(bridge.activeNamespaces()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MEM-9: promote prunes the source copy on a prune-by-path backend
// ---------------------------------------------------------------------------

describe('MEM-9 promote source-prune on markdown-note', () => {
  it('removes the branch copy even though the driver declares namespaces:false', async () => {
    const server = markdownNoteServer({ serverId: 'basic_memory' });
    const bridge = bridgeFor(server);
    await bridge.initialize();
    const promoted = await bridge.promote(validLesson(), { from: branchScope(), to: { kind: 'global' } });
    expect(promoted.accepted).toBe(true);

    const deletes = server.callsTo('delete_note');
    expect(deletes.length).toBeGreaterThan(0);
    expect(String(deletes[0]?.args.path)).toContain('harness2/branch/s-1/b-1/L-1.md');
    // Only the global copy remains — no silently deduped duplicate.
    expect(server.store.filter((record) => record.namespace === BRANCH_A_NS)).toHaveLength(0);
    expect(server.store.filter((record) => record.namespace === GLOBAL_NS)).toHaveLength(1);
    expect(promoted.violations.filter((entry) => entry.severity === 'block')).toEqual([]);
  });

  it('does not report an unpruned source copy when the driver supports prune', async () => {
    const server = graphEntityServer({ serverId: 'official_kg' });
    const bridge = bridgeFor(server);
    await bridge.initialize();
    const promoted = await bridge.promote(validLesson(), { from: branchScope(), to: { kind: 'global' } });
    expect(promoted.accepted).toBe(true);
    expect(promoted.violations.some((entry) => entry.message.includes('could not be removed'))).toBe(false);
    expect(server.store.filter((record) => record.namespace === BRANCH_A_NS)).toHaveLength(0);
  });

  it('warns instead of skipping silently when the backend has no prune tool', async () => {
    // A markdown-note backend whose tools/list omits the delete tool: the
    // driver declares supportsPrune:false, and promote must report that the
    // branch copy could not be removed rather than leave it silently.
    const server = markdownNoteServer({ serverId: 'basic_memory' });
    const client = server.client;
    const originalListTools = client.listTools.bind(client);
    client.listTools = async () => (await originalListTools()).filter((tool) => tool.name !== 'delete_note');
    const bridge = bridgeFor(server);
    await bridge.initialize();
    const promoted = await bridge.promote(validLesson(), { from: branchScope(), to: { kind: 'global' } });
    expect(promoted.accepted).toBe(true);
    expect(
      promoted.violations.some(
        (entry) => entry.severity === 'warn' && entry.message.includes('cannot be removed')
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MEM-10: the dead enforceGovernance contract option is gone
// ---------------------------------------------------------------------------

describe('MEM-10 enforceGovernance is no longer a contract surface', () => {
  it('accepts commit options with only scope/dryRun and still runs the gate', async () => {
    const server = vectorFactServer({ serverId: 'mem0' });
    const bridge = bridgeFor(server);
    await bridge.initialize();
    const options: MemoryCommitOptions = { scope: branchScope() };
    // An incomplete lesson is rejected by the unconditional gate: no option can
    // downgrade it.
    const blocked = await bridge.commit(validLesson({ whenNotToApply: [] }), options);
    expect(blocked.accepted).toBe(false);
    expect(blocked.violations.map((entry) => entry.code)).toContain('missing_when_not_to_apply');
    expect(server.callsTo('add_memory')).toHaveLength(0);
  });
});
