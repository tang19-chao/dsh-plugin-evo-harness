import { describe, expect, it } from 'vitest';
import type { MemorySurfaceEdit } from '../../../src/types/contracts';
import {
  Harness2ProposalError,
  createDualTrackProposer,
  decideProposalGuidance,
  renderProposalPrompts
} from '../../../src/harness2/proposer';
import { createDeterministicIdFactory } from '../../../src/harness2/shared';
import {
  fixedClock,
  makeProposeRequest,
  makeRecall,
  makeSlot,
  proposalJson,
  promptText,
  requestAt,
  scriptedModel
} from './fixtures';

const POSITIVE_TITLE = 'Inject a SQL schema SOP before querying';
const NEGATIVE_TITLE = 'Never batch parallel tool calls before the schema is known';

function makeProposer(script: readonly (string | Error)[]) {
  const model = scriptedModel(script);
  const proposer = createDualTrackProposer({
    model,
    now: fixedClock(),
    newId: createDeterministicIdFactory('test')
  });
  return { model, proposer };
}

describe('Harness² proposer / asymmetric guidance', () => {
  it('renders positive lessons and anti-pattern warnings for a domain exploit slot', async () => {
    const { model, proposer } = makeProposer([proposalJson()]);
    const request = makeProposeRequest({
      slot: makeSlot({ slot: 'exploit', origin: 'domain', guidance: 'memory', seedPatchIds: ['patch_root'] })
    });

    const result = await proposer.propose(request);
    const prompt = promptText(model);

    expect(prompt).toContain('positive_lessons (recommendations');
    expect(prompt).toContain(POSITIVE_TITLE);
    expect(prompt).toContain('<anti_patterns_to_avoid>');
    expect(prompt).toContain(NEGATIVE_TITLE);
    expect(prompt).toContain('evidence: reference failed with a syntax error');

    expect(result.patch.guidance).toBe('memory');
    expect(result.patch.sourceLessonIds).toEqual(['lesson_recall_1', 'lesson_recall_2']);
    expect(result.patch.purpose).toBe('deepen');
    expect(result.patch.origin).toBe('domain');
    expect(result.patch.branchId).toBe('branch_1');
    expect(result.patch.parentPatchIds).toEqual(['patch_root']);
    expect(result.confidence).toBeCloseTo(0.7, 5);
    expect(result.expectedStepsDelta).toBe(-1);
    expect(result.focusSurfaces).toEqual(['guardrails']);
  });

  it('renders no external memory content for an invariant guidance-free slot', async () => {
    const { model, proposer } = makeProposer([
      proposalJson({
        rationale: 'Add a first-principles terseness rule.',
        focusSurfaces: ['system_prompt'],
        edits: { system_prompt: { kind: 'system_prompt', mode: 'append', content: 'Be terse.' } }
      })
    ]);
    const request = makeProposeRequest({
      slot: makeSlot({
        slot: 'explore_invariant',
        origin: 'invariant',
        guidance: 'guidance_free',
        focusSurfaces: ['system_prompt']
      }),
      guidance: { mode: 'invariant', memory: null }
    });

    const result = await proposer.propose(request);
    const prompt = promptText(model);

    expect(prompt).toContain('GUIDANCE-FREE branch');
    expect(prompt).toContain('External memory is DISABLED');
    expect(prompt).not.toContain(POSITIVE_TITLE);
    expect(prompt).not.toContain(NEGATIVE_TITLE);
    expect(prompt).not.toContain('lesson_recall_1');
    expect(prompt).not.toContain('anti_pattern');

    expect(result.patch.guidance).toBe('guidance_free');
    expect(result.patch.sourceLessonIds).toEqual([]);
    expect(result.patch.metadata?.guidanceSanitized).toBe(false);
    expect(result.patch.edits.system_prompt?.kind).toBe('system_prompt');
  });

  it('strips domain memory that arrives on a guidance-free invariant slot', async () => {
    const { model, proposer } = makeProposer([
      proposalJson({
        focusSurfaces: ['memory'],
        edits: { memory: { kind: 'memory', recallTags: ['sql'], workingNotes: ['draft the schema first'] } }
      })
    ]);
    const request = makeProposeRequest({
      slot: makeSlot({ slot: 'explore_invariant', origin: 'invariant', guidance: 'guidance_free' }),
      // Deliberately contaminated input: a domain guidance object on an invariant slot.
      guidance: { mode: 'domain', memory: makeRecall() }
    });

    const decision = decideProposalGuidance(request);
    expect(decision.memoryAllowed).toBe(false);
    expect(decision.sanitized).toBe(true);

    const result = await proposer.propose(request);
    const prompt = promptText(model);
    const memoryEdit = result.patch.edits.memory as MemorySurfaceEdit;

    expect(prompt).not.toContain(POSITIVE_TITLE);
    expect(prompt).not.toContain('anti_patterns_to_avoid');
    expect(result.patch.guidance).toBe('guidance_free');
    expect(result.patch.sourceLessonIds).toEqual([]);
    expect(result.patch.metadata?.guidanceSanitized).toBe(true);
    expect(memoryEdit.recallTags).toBeUndefined();
    expect(memoryEdit.workingNotes).toEqual(['draft the schema first']);
    expect((result.patch.metadata?.droppedEdits as string[]).join(' | ')).toContain('memory.recallTags stripped');
  });

  it('drops the memory surface entirely when only recall tags remain on a guidance-free slot', async () => {
    const { proposer } = makeProposer([
      proposalJson({
        focusSurfaces: ['memory', 'plugins'],
        edits: {
          memory: { kind: 'memory', recallTags: ['sql'] },
          plugins: {
            kind: 'plugins',
            middleware: [
              { name: 'retry-guard', hook: 'before_tool', language: 'typescript', code: 'export const x = 1;' }
            ]
          }
        }
      })
    ]);
    const request = makeProposeRequest({
      slot: makeSlot({ slot: 'explore_invariant', origin: 'invariant', guidance: 'guidance_free' }),
      guidance: { mode: 'invariant', memory: null }
    });

    const result = await proposer.propose(request);
    expect(result.patch.edits.memory).toBeUndefined();
    expect(result.patch.edits.plugins?.kind).toBe('plugins');
    expect((result.patch.metadata?.droppedEdits as string[]).join(' | ')).toContain('only recallTags remained');
  });
});

describe('Harness² proposer / deterministic parsing', () => {
  it('keeps valid edits, drops invalid payloads and disabled surfaces', async () => {
    const { proposer } = makeProposer([
      proposalJson({
        edits: {
          unknown_surface: { kind: 'unknown_surface' },
          skills: { kind: 'skills' },
          system_prompt: { kind: 'system_prompt', mode: 'append', content: 'Prefer JSON output.' }
        }
      })
    ]);
    const request = makeProposeRequest({ enabledSurfaces: ['system_prompt', 'skills'] });

    const result = await proposer.propose(request);
    expect(Object.keys(result.patch.edits)).toEqual(['system_prompt']);
    const dropped = (result.patch.metadata?.droppedEdits as string[]).join(' | ');
    expect(dropped).toContain('unknown_surface: unknown harness surface');
    expect(dropped).toContain('skills: skills must be a non-empty array');
    expect(result.focusSurfaces).toEqual(['system_prompt']);
  });

  it('accepts a fenced JSON proposal and normalizes focus surfaces to edited keys', async () => {
    const { proposer } = makeProposer([
      'Here is the proposal:' + String.fromCharCode(10) +
        String.fromCharCode(96).repeat(3) + 'json' + String.fromCharCode(10) +
        proposalJson({ focusSurfaces: ['scripts'], edits: { guardrails: { kind: 'guardrails', appendRules: ['Cite files.'] } } }) +
        String.fromCharCode(10) + String.fromCharCode(96).repeat(3)
    ]);
    const result = await proposer.propose(makeProposeRequest());
    expect(result.focusSurfaces).toEqual(['guardrails']);
  });

  it('throws a typed error when the model response is not JSON', async () => {
    const { proposer } = makeProposer(['I am unable to comply.']);
    await expect(proposer.propose(makeProposeRequest())).rejects.toBeInstanceOf(Harness2ProposalError);
    await expect(proposer.propose(makeProposeRequest())).rejects.toMatchObject({
      code: 'proposal_unparseable'
    });
  });

  it('throws a typed error when every proposed edit is invalid', async () => {
    const { proposer } = makeProposer([proposalJson({ edits: { guardrails: { kind: 'guardrails' } } })]);
    await expect(proposer.propose(makeProposeRequest())).rejects.toMatchObject({
      code: 'proposal_no_valid_edits'
    });
  });

  it('is byte-for-byte deterministic for identical inputs and fake responses', async () => {
    const request = makeProposeRequest();
    const first = await makeProposer([proposalJson()]).proposer.propose(request);
    const second = await makeProposer([proposalJson()]).proposer.propose(request);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('renders identical prompts for identical requests (pure renderer)', () => {
    const request = makeProposeRequest();
    expect(renderProposalPrompts(request)).toEqual(renderProposalPrompts(request));
    const messages = renderProposalPrompts(request);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
    expect(messages[0]?.content).toContain('Surfaces (stable order): system_prompt, guardrails');
  });

  it('sends a json-formatted propose request with slot metadata', async () => {
    const { model, proposer } = makeProposer([proposalJson()]);
    await proposer.propose(makeProposeRequest());
    const request = requestAt(model);
    expect(request.purpose).toBe('propose');
    expect(request.responseFormat).toBe('json');
    expect(request.temperature).toBe(0.2);
    expect(request.metadata?.slot).toBe('explore_domain');
    expect(request.metadata?.guidance).toBe('memory');
  });
});
