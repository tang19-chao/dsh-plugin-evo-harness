/**
 * A1 contract (rev6 audit B1): the patch EDITS a probe is meant to evaluate
 * must reach its prompt, while the default header and task keep their exact
 * bytes and position.
 *
 * Every fixture here is TYPED against the frozen contracts (`EightSurfacePatch`
 * / `IsolatedBranchContext`) via the shared cordis-seams fixtures, so a schema
 * drift is a compile error instead of an `any` that silently accepts anything.
 */
import { describe, expect, it } from 'vitest';

import {
  PATCH_PROMPT_PREFIX,
  TEXT_PROBE_EVALUABLE,
  TEXT_PROBE_NOT_EVALUABLE,
  appendPatchSections,
  renderPatchSections
} from '../../../src/dsh-bridge/patch-prompt';
import { defaultBranchMessages, createBranchExecutor } from '../../../src/dsh-bridge/branch';
import { createEvoHarnessPlugin } from '../../../src/index';
import type {
  EightSurfaceEdits,
  HarnessComponentKey,
  IsolatedBranchContext,
  ModelMessage,
  ModelRequest
} from '../../../src/types/contracts';
import { makePatch, makeTask } from '../cordis-seams/fixtures';
import {
  createFakeContext,
  createPatchAwareHostLlm,
  e2eConfig,
  makeClock
} from '../../e2e/fixtures';

const MARK_SYS = 'MARKER_SYS_7731';
const MARK_GUARD = 'MARKER_GUARD_4412';

/** A fully typed branch context carrying exactly the supplied edits. */
function contextWith(edits: EightSurfaceEdits): IsolatedBranchContext {
  return {
    branchId: 'br-a1',
    sessionId: 'sess-a1',
    namespace: 'harness2:probe_br-a1',
    task: makeTask(),
    patch: makePatch({ edits }),
    mountedSurfaces: Object.keys(edits) as readonly HarnessComponentKey[],
    signal: new AbortController().signal
  };
}

/** Join a message list into one searchable text. */
function textOfMessages(messages: readonly ModelMessage[]): string {
  return messages.map((message) => message.content).join('\n');
}

/** The list of non-evaluable surface names in rendered order. */
function notEvaluableOf(edits: EightSurfaceEdits): readonly HarnessComponentKey[] {
  return renderPatchSections(contextWith(edits)).notEvaluable;
}

describe('patch-prompt: rendering contract', () => {
  it('declares exactly the five text-evaluable surfaces and derives the complement', () => {
    expect([...TEXT_PROBE_EVALUABLE]).toEqual([
      'system_prompt',
      'guardrails',
      'memory',
      'tool_guidance',
      'skills'
    ]);
    expect([...TEXT_PROBE_NOT_EVALUABLE]).toEqual(['scripts', 'subagents', 'plugins']);
  });

  it('renders system_prompt append in its own fixed section', () => {
    const rendered = renderPatchSections(
      contextWith({
        system_prompt: { kind: 'system_prompt', mode: 'append', content: MARK_SYS }
      })
    );
    expect(rendered.replaceSystem).toBeUndefined();
    expect(rendered.sections).toEqual(['## system_prompt (append)\n' + MARK_SYS]);
  });

  it('renders every guardrails field with its documented label', () => {
    const rendered = renderPatchSections(
      contextWith({
        guardrails: {
          kind: 'guardrails',
          formatContract: MARK_GUARD,
          appendRules: ['rule-marker-1', 'rule-marker-2'],
          forbiddenActions: ['forbid-marker'],
          toolPreconditions: [{ toolName: 'shell', rule: 'precondition-marker' }]
        }
      })
    );
    const body = rendered.sections.join('\n');
    expect(body).toContain('## guardrails');
    expect(body).toContain('Output contract: ' + MARK_GUARD);
    expect(body).toContain('- rule-marker-1');
    expect(body).toContain('- rule-marker-2');
    expect(body).toContain('- forbidden: forbid-marker');
    expect(body).toContain('- precondition shell: precondition-marker');
  });

  it('renders memory working notes and recall tags without a recall or a view id', () => {
    const rendered = renderPatchSections(
      contextWith({
        memory: {
          kind: 'memory',
          scopedViewId: 'view-must-not-be-rendered',
          workingNotes: ['working-note-marker'],
          recallTags: ['recall-tag-marker']
        }
      })
    );
    const body = rendered.sections.join('\n');
    expect(body).toContain('## memory (branch-scoped working notes)');
    expect(body).toContain('- working-note-marker');
    expect(body).toContain('- recall tag: recall-tag-marker');
    expect(body).not.toContain('view-must-not-be-rendered');
  });

  it('renders tool_guidance descriptions, priority and examples', () => {
    const rendered = renderPatchSections(
      contextWith({
        tool_guidance: {
          kind: 'tool_guidance',
          descriptions: { shell: 'description-marker' },
          priorityOrder: ['shell', 'read_file'],
          examples: [{ toolName: 'shell', example: 'example-marker' }]
        }
      })
    );
    const body = rendered.sections.join('\n');
    expect(body).toContain('## tool_guidance');
    expect(body).toContain('- shell: description-marker');
    expect(body).toContain('- priority: shell > read_file');
    expect(body).toContain('- example shell: example-marker');
  });

  it('renders one named section per skill, including its markdown', () => {
    const rendered = renderPatchSections(
      contextWith({
        skills: {
          kind: 'skills',
          skills: [
            { name: 'build-sop', markdown: 'skill-markdown-marker' },
            { name: 'release-sop', markdown: '# Release' }
          ]
        }
      })
    );
    expect(rendered.sections).toEqual([
      '## skill: build-sop\nskill-markdown-marker',
      '## skill: release-sop\n# Release'
    ]);
  });

  it('lists present non-evaluable surfaces but never renders their payload bodies', () => {
    // The all-eight fixture carries scripts code, a subagent description and
    // plugin middleware code; none of those strings may reach the prompt.
    const context = { ...contextWith({}) };
    const allEight = makePatch();
    const withAll: IsolatedBranchContext = { ...context, patch: allEight };
    const output = textOfMessages(appendPatchSections(defaultBranchMessages(withAll), withAll));

    expect(output).toContain('## not evaluable in a text probe: scripts, subagents, plugins');
    expect(output).not.toContain('print(1)');
    expect(output).not.toContain('explore the repo');
    expect(output).not.toContain('export default () => undefined;');
    expect(notEvaluableOf(allEight.edits)).toEqual(['scripts', 'subagents', 'plugins']);
  });

  it('orders patch sections system_prompt -> guardrails -> memory -> tool_guidance -> skills -> not-evaluable', () => {
    const edits = makePatch().edits;
    const rendered = renderPatchSections(contextWith(edits));
    const body = rendered.sections.join('\n\n');
    const positions = [
      body.indexOf('## system_prompt'),
      body.indexOf('## guardrails'),
      body.indexOf('## memory'),
      body.indexOf('## tool_guidance'),
      body.indexOf('## skill:'),
      body.indexOf('## not evaluable')
    ];
    // The first five live in `sections`; not-evaluable is the appended line.
    for (let index = 1; index < 5; index += 1) {
      expect(positions[index], 'section order at ' + String(index)).toBeGreaterThan(positions[index - 1] ?? -1);
    }
    const full = textOfMessages(appendPatchSections(defaultBranchMessages(contextWith(edits)), contextWith(edits)));
    expect(full.indexOf('## not evaluable in a text probe')).toBeGreaterThan(full.indexOf('## skill:'));
  });
});

describe('patch-prompt: message list compatibility', () => {
  it('returns the SAME base array when the patch renders nothing', () => {
    const context = contextWith({});
    const base = defaultBranchMessages(context);
    const out = appendPatchSections(base, context);
    expect(out).toBe(base);
    expect(out).toEqual(defaultBranchMessages(context));
  });

  it('treats a key with an empty payload as rendering nothing (A1/A3 content gate)', () => {
    for (const edits of [
      { guardrails: { kind: 'guardrails' as const, appendRules: [] } },
      { guardrails: { kind: 'guardrails' as const, forbiddenActions: [], toolPreconditions: [] } },
      { memory: { kind: 'memory' as const, scopedViewId: 'view-only' } },
      { memory: { kind: 'memory' as const, workingNotes: [], recallTags: [] } },
      { tool_guidance: { kind: 'tool_guidance' as const, descriptions: {} } },
      { skills: { kind: 'skills' as const, skills: [] } }
    ] satisfies EightSurfaceEdits[]) {
      const context = contextWith(edits);
      const base = defaultBranchMessages(context);
      const rendered = renderPatchSections(context);
      expect(rendered.sections).toEqual([]);
      expect(rendered.renderedSurfaces).toEqual([]);
      expect(appendPatchSections(base, context)).toBe(base);
    }
  });

  it('exposes exactly the surfaces whose content rendered', () => {
    const context = contextWith({
      system_prompt: { kind: 'system_prompt', mode: 'append', content: MARK_SYS },
      guardrails: { kind: 'guardrails', formatContract: MARK_GUARD },
      memory: { kind: 'memory', scopedViewId: 'view-only' },
      skills: { kind: 'skills', skills: [{ name: 'sop', markdown: '# SOP' }] }
    });
    expect(renderPatchSections(context).renderedSurfaces).toEqual([
      'system_prompt',
      'guardrails',
      'skills'
    ]);
  });

  it('keeps the default header first and the task last for EACH request (header is per-context)', () => {
    const context = contextWith({
      system_prompt: { kind: 'system_prompt', mode: 'append', content: MARK_SYS },
      guardrails: { kind: 'guardrails', formatContract: MARK_GUARD }
    });
    const base = defaultBranchMessages(context);
    const out = appendPatchSections(base, context);

    expect(out.length).toBe(base.length + 1);
    expect(out[0]).toBe(base[0]);
    expect(out[1]?.role).toBe('system');
    expect(out[1]?.content.startsWith(PATCH_PROMPT_PREFIX + '\n')).toBe(true);
    expect(out[1]?.content).toContain(MARK_SYS);
    expect(out[1]?.content).toContain(MARK_GUARD);
    expect(out.at(-1)).toEqual(base.at(-1));

    // The header embeds branch/namespace/patch id and rationale, so it is NOT a
    // cross-request prefix: two different contexts must not share it. The test
    // name used to imply a cache-stable prefix; this assertion pins the real
    // contract instead.
    const other = { ...context, branchId: 'br-a1-other', patch: makePatch({ id: 'patch-other', edits: context.patch.edits }) };
    const otherOut = appendPatchSections(defaultBranchMessages(other), other);
    expect(otherOut[0]).not.toEqual(out[0]);
    expect(otherOut[1]?.content.startsWith(PATCH_PROMPT_PREFIX + '\n')).toBe(true);
  });

  it('renders system_prompt replace as a section and never overwrites the header', () => {
    const context = contextWith({
      system_prompt: { kind: 'system_prompt', mode: 'replace', content: MARK_SYS }
    });
    const base = defaultBranchMessages(context);
    const out = appendPatchSections(base, context);

    expect(out[0]).toEqual(base[0]);
    expect(out[0]?.content).not.toContain(MARK_SYS);
    expect(out[1]?.content).toContain('## system_prompt (replace)\n' + MARK_SYS);
    expect(out[1]?.content).not.toContain('## system_prompt (append)');
  });

  it('is total on malformed edits instead of throwing before the executor try/catch', () => {
    const context = {
      ...contextWith({}),
      patch: { ...makePatch(), edits: undefined as unknown as EightSurfaceEdits }
    };
    expect(renderPatchSections(context)).toEqual({ sections: [], renderedSurfaces: [], notEvaluable: [] });
    const base = defaultBranchMessages(context);
    expect(appendPatchSections(base, context)).toBe(base);
  });

  it('a host buildMessages wins over the patch-aware default in the same-process executor', async () => {
    const requests: ModelRequest[] = [];
    const executor = createBranchExecutor(
      {},
      {
        model: {
          async complete(request: ModelRequest) {
            requests.push(request);
            return { text: 'host-only deliverable', finishReason: 'stop' as const };
          }
        },
        buildMessages: () => [{ role: 'system' as const, content: 'HOST-ONLY-PROMPT' }]
      }
    );

    const result = await executor.runBranch(
      contextWith({
        system_prompt: { kind: 'system_prompt', mode: 'append', content: MARK_SYS },
        guardrails: { kind: 'guardrails', formatContract: MARK_GUARD }
      })
    );

    expect(result.status).toBe('succeeded');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toEqual([{ role: 'system', content: 'HOST-ONLY-PROMPT' }]);
    expect(JSON.stringify(requests[0]?.messages)).not.toContain(MARK_SYS);
    expect(JSON.stringify(requests[0]?.messages)).not.toContain(PATCH_PROMPT_PREFIX);
  });

  it('the same-process DEFAULT builder renders the patch and keeps the header first', async () => {
    const requests: ModelRequest[] = [];
    const executor = createBranchExecutor(
      {},
      {
        model: {
          async complete(request: ModelRequest) {
            requests.push(request);
            return { text: 'patched deliverable', finishReason: 'stop' as const };
          }
        }
      }
    );
    const context = contextWith({
      system_prompt: { kind: 'system_prompt', mode: 'append', content: MARK_SYS }
    });

    const result = await executor.runBranch(context);

    expect(result.status).toBe('succeeded');
    const messages = requests[0]?.messages ?? [];
    expect(messages[0]).toEqual(defaultBranchMessages(context)[0]);
    expect(messages[1]?.content.startsWith(PATCH_PROMPT_PREFIX + '\n')).toBe(true);
    expect(messages[1]?.content).toContain(MARK_SYS);
    expect(messages.at(-1)).toEqual(defaultBranchMessages(context).at(-1));
  });
});

describe('patch-prompt: end-to-end probe content (A2 permanent gate)', () => {
  it('sends patch markers to every candidate probe and none to the reference', async () => {
    const host = createPatchAwareHostLlm({
      proposals: [
        {
          rationale: 'render the patch into the probe prompt',
          focusSurfaces: ['system_prompt', 'guardrails'],
          confidence: 0.7,
          expectedStepsDelta: -1,
          edits: {
            system_prompt: {
              kind: 'system_prompt',
              mode: 'append',
              content: 'append ' + MARK_SYS
            },
            guardrails: {
              kind: 'guardrails',
              formatContract: 'contract ' + MARK_GUARD
            }
          }
        }
      ]
    });
    const { ctx } = createFakeContext();
    const plugin = createEvoHarnessPlugin(
      { config: e2eConfig(), now: makeClock() },
      { ...ctx, llm: host }
    );
    await plugin.collaborators;

    const result = await plugin.run({
      sessionId: 'sess-a1-e2e',
      task: plugin.makeTask({ prompt: 'Fix the failing build.' }),
      trigger: 'always'
    });

    expect(result.outcome).not.toBe('no_probe');
    expect(result.probesRun).toBeGreaterThan(1);

    const referenceDispatches = host.probeDispatches.filter(
      (dispatch) => dispatch.branch?.startsWith('reference-') === true
    );
    const candidateDispatches = host.probeDispatches.filter(
      (dispatch) => dispatch.branch?.startsWith('reference-') !== true
    );
    expect(referenceDispatches).toHaveLength(1);
    expect(candidateDispatches).toHaveLength(result.probesRun - 1);
    const candidates = candidateDispatches.filter((dispatch) =>
      dispatch.prompt.includes(PATCH_PROMPT_PREFIX)
    );
    expect(candidates).toHaveLength(candidateDispatches.length);
    expect(candidates.every((dispatch) => dispatch.prompt.includes(MARK_SYS) && dispatch.prompt.includes(MARK_GUARD))).toBe(true);
    expect(referenceDispatches.every((dispatch) => !dispatch.prompt.includes(MARK_SYS) && !dispatch.prompt.includes(MARK_GUARD))).toBe(true);
  });
});
