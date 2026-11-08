import { describe, expect, it } from 'vitest';
import { DshModelStreamError } from '../../../src/dsh-bridge/model';
import type { MemorySurfaceEdit } from '../../../src/types/contracts';
import {
  Harness2ProposalError,
  createDualTrackProposer,
  decideProposalGuidance,
  isTransportClassModelError,
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

  it('rejects contentless right-kind payloads instead of accepting a rationale-only patch', async () => {
    for (const edits of [
      { guardrails: { kind: 'guardrails', appendRules: [] } },
      { guardrails: { kind: 'guardrails', forbiddenActions: [] } },
      { memory: { kind: 'memory', scopedViewId: 'view-only' } },
      { memory: { kind: 'memory', workingNotes: [], recallTags: [] } }
    ]) {
      const { proposer } = makeProposer([proposalJson({ edits })]);
      await expect(proposer.propose(makeProposeRequest())).rejects.toMatchObject({
        code: 'proposal_no_valid_edits',
        notEvaluable: false
      });
    }
  });

  it('marks a known-but-disabled-only proposal as notEvaluable (A3/B9)', async () => {
    const request = makeProposeRequest({
      enabledSurfaces: ['system_prompt', 'guardrails', 'memory', 'tool_guidance', 'skills']
    });
    const { proposer } = makeProposer([proposalJson({ edits: { scripts: { kind: 'scripts', scripts: [{ path: 'x.py', language: 'python', code: 'print(1)' }] } } })]);
    await expect(proposer.propose(request)).rejects.toMatchObject({
      code: 'proposal_no_valid_edits',
      notEvaluable: true,
      droppedSurfaces: ['scripts']
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

  it('filters the surface legend AND payload contracts to enabledSurfaces (A3/B9)', () => {
    const allowed = ['system_prompt', 'guardrails', 'memory', 'tool_guidance', 'skills'] as const;
    const messages = renderProposalPrompts(makeProposeRequest({ enabledSurfaces: [...allowed] }));
    const system = String(messages[0]?.content ?? '');
    const user = String(messages[1]?.content ?? '');
    expect(system).toContain('Surfaces (stable order): ' + allowed.join(', '));
    for (const disabled of ['scripts', 'subagents', 'plugins']) {
      expect(system).not.toContain('- ' + disabled + ':');
    }
    // The user-visible allowed list is the same intersection.
    expect(user).toContain('allowedSurfaces: ' + allowed.join(', '));
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

describe('Harness² proposer / multi-candidate path (P3-B)', () => {
  const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    JSON.parse(proposalJson(overrides)) as Record<string, unknown>;

  it('returns K candidates in order from exactly one model call', async () => {
    const set = JSON.stringify([
      payload({ rationale: 'First.', confidence: 0.9, edits: { guardrails: { kind: 'guardrails', formatContract: 'A' } } }),
      payload({ rationale: 'Second.', confidence: 0.5, edits: { system_prompt: { kind: 'system_prompt', mode: 'append', content: 'B' } } }),
      payload({ rationale: 'Third.', confidence: 0.1, edits: { memory: { kind: 'memory', workingNotes: ['C'] } } })
    ]);
    const { model, proposer } = makeProposer([set]);
    const request = makeProposeRequest({ candidateCount: 3 });

    const result = await proposer.proposeCandidates!(request);

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.metadata?.candidateCount).toBe(3);
    expect(promptText(model, 0)).toContain('JSON ARRAY of exactly 3');
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map((candidate) => candidate.rationale)).toEqual(['First.', 'Second.', 'Third.']);
    expect(result.candidates.map((candidate) => candidate.confidence)).toEqual([0.9, 0.5, 0.1]);
    expect(result.candidates.map((candidate) => candidate.patch.guidance)).toEqual(['memory', 'memory', 'memory']);
  });

  it('keeps K=1 and K undefined on the unchanged single-candidate path', async () => {
    const { model, proposer } = makeProposer([proposalJson(), proposalJson()]);
    const one = await proposer.proposeCandidates!(makeProposeRequest({ candidateCount: 1 }));
    expect(model.requests).toHaveLength(1);
    expect(one.candidates).toHaveLength(1);
    expect(one.candidates[0]?.confidence).toBeCloseTo(0.7, 5);
    expect(model.requests[0]?.metadata?.candidateCount).toBeUndefined();
    const undef = await proposer.proposeCandidates!(makeProposeRequest({}));
    expect(model.requests).toHaveLength(2);
    expect(undef.candidates).toHaveLength(1);
    expect(promptText(model, 1)).not.toContain('JSON ARRAY');
    expect(promptText(model, 1)).toContain('Return exactly ONE JSON object');
  });

  it('drops invalid candidates and records diagnostics without failing the call', async () => {
    const set = JSON.stringify([
      payload({ rationale: 'Good.', edits: { guardrails: { kind: 'guardrails', formatContract: 'A' } } }),
      'not an object',
      payload({ rationale: 'Empty edits.', edits: {} }),
      payload({ rationale: 'Bad payload.', edits: { guardrails: { kind: 'nope' } } })
    ]);
    const { model, proposer } = makeProposer([set]);

    const result = await proposer.proposeCandidates!(makeProposeRequest({ candidateCount: 4 }));

    expect(model.requests).toHaveLength(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.rationale).toBe('Good.');
    const diagnostics = result.candidates[0]?.patch.metadata?.diagnostics as string[];
    const joined = diagnostics.join(' | ');
    expect(joined).toContain('candidate 2: dropped, not a JSON object');
    expect(joined).toContain('candidate 3: dropped, no valid surface edit');
    expect(joined).toContain('multi-candidate proposal: requested 4, accepted 1');
  });

  it('falls back to the single-candidate path when every candidate is invalid', async () => {
    const { model, proposer } = makeProposer([
      JSON.stringify([{ rationale: 'Empty.', edits: {} }]),
      proposalJson()
    ]);

    const result = await proposer.proposeCandidates!(makeProposeRequest({ candidateCount: 3 }));

    expect(model.requests).toHaveLength(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.confidence).toBeCloseTo(0.7, 5);
    const diagnostics = result.candidates[0]?.patch.metadata?.diagnostics as string[];
    expect(diagnostics.join(' | ')).toContain('0 valid); fell back to the single-candidate path');
  });

  it('clamps out-of-range confidences and defaults missing ones to 0.5', async () => {
    const set = JSON.stringify([
      payload({ rationale: 'High.', confidence: 7, edits: { guardrails: { kind: 'guardrails', formatContract: 'A' } } }),
      payload({ rationale: 'Negative.', confidence: -2, edits: { guardrails: { kind: 'guardrails', formatContract: 'B' } } }),
      // confidence: undefined is dropped by JSON.stringify, so the payload
      // genuinely lacks the key and the 0.5 default must apply.
      payload({ rationale: 'Missing.', confidence: undefined, edits: { guardrails: { kind: 'guardrails', formatContract: 'C' } } })
    ]);
    const { model, proposer } = makeProposer([set]);

    const result = await proposer.proposeCandidates!(makeProposeRequest({ candidateCount: 3 }));

    expect(model.requests).toHaveLength(1);
    expect(result.candidates.map((candidate) => candidate.confidence)).toEqual([1, 0, 0.5]);
  });

  it('keeps guidance_free slots free of memory recall even when K > 1', async () => {
    const set = JSON.stringify([
      payload({ rationale: 'One.', edits: { system_prompt: { kind: 'system_prompt', mode: 'append', content: 'A' } } }),
      payload({ rationale: 'Two.', edits: { system_prompt: { kind: 'system_prompt', mode: 'append', content: 'B' } } }),
      payload({ rationale: 'Three.', edits: { system_prompt: { kind: 'system_prompt', mode: 'append', content: 'C' } } })
    ]);
    const { model, proposer } = makeProposer([set]);
    const request = makeProposeRequest({
      candidateCount: 3,
      slot: makeSlot({
        slot: 'explore_invariant',
        origin: 'invariant',
        guidance: 'guidance_free',
        focusSurfaces: ['system_prompt']
      }),
      guidance: { mode: 'invariant', memory: null }
    });

    const result = await proposer.proposeCandidates!(request);

    const prompt = promptText(model, 0);
    expect(prompt).not.toContain(POSITIVE_TITLE);
    expect(prompt).not.toContain(NEGATIVE_TITLE);
    expect(result.candidates).toHaveLength(3);
    for (const candidate of result.candidates) {
      expect(candidate.patch.guidance).toBe('guidance_free');
      expect(candidate.patch.sourceLessonIds).toEqual([]);
      expect(candidate.patch.metadata?.memoryRecallIds).toEqual([]);
    }
  });
});

/**
 * rev8 plan §3.1 #110/#13: transport-class model failures (gateway 429/5xx,
 * network reset, aborted stream) used to escape the metered adapter and drop
 * the whole slot. The proposer now retries them once with a bounded backoff,
 * and ONLY them - every other failure class reaches the caller untouched.
 */
describe('Harness² proposer / transport retry (rev8 #110/#13)', () => {
  /** A makeProposer variant that also captures the injected sleep log. */
  function makeRetryingProposer(
    script: readonly (string | Error)[],
    overrides: Partial<Parameters<typeof createDualTrackProposer>[0]> = {}
  ) {
    const sleptMs: number[] = [];
    const model = scriptedModel(script);
    const proposer = createDualTrackProposer({
      model,
      now: fixedClock(),
      newId: createDeterministicIdFactory('test'),
      transportRetryBackoffMs: 500,
      sleep: async (ms: number) => {
        sleptMs.push(ms);
      },
      ...overrides
    });
    return { model, proposer, sleptMs };
  }

  /** A gateway-shaped transport error with a provable HTTP status. */
  function httpError(status: number): Error {
    const error: Error & { status: number; name: string } = Object.assign(new Error('gateway ' + String(status)), {
      name: 'GatewayHttpError',
      status
    });
    return error;
  }

  it('classifies transport-class errors and refuses everything else', () => {
    expect(isTransportClassModelError(httpError(429))).toBe(true);
    expect(isTransportClassModelError(httpError(500))).toBe(true);
    expect(isTransportClassModelError(httpError(503))).toBe(true);
    expect(isTransportClassModelError(new DshModelStreamError('slow down', 'error', 'RATE_LIMIT'))).toBe(true);
    expect(isTransportClassModelError(new DshModelStreamError('cut off mid-stream', 'aborted'))).toBe(true);
    const network: Error & { code: string } = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    expect(isTransportClassModelError(network)).toBe(true);
    // undici wraps the real network error inside `fetch failed` (no direct code).
    const fetchFailed: Error & { cause: Error & { code: string } } = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    });
    expect(isTransportClassModelError(fetchFailed)).toBe(true);
    // Non-transport classes: application statuses, plain errors, budget denials,
    // permission failures (AUTH / EACCES), and DSH codes that do not prove transport.
    expect(isTransportClassModelError(httpError(400))).toBe(false);
    expect(isTransportClassModelError(httpError(403))).toBe(false);
    expect(isTransportClassModelError(httpError(404))).toBe(false);
    expect(isTransportClassModelError(new Error('model produced nonsense'))).toBe(false);
    expect(isTransportClassModelError(new DshModelStreamError('bad key', 'error', 'AUTH'))).toBe(false);
    const denied: Error & { code: string } = Object.assign(new Error('not permitted'), { code: 'EACCES' });
    expect(isTransportClassModelError(denied)).toBe(false);
    expect(isTransportClassModelError(new Harness2ProposalError('proposal_unparseable', 'm', 'd'))).toBe(false);
  });

  it('does not retry (and does not sleep) when the first attempt succeeds', async () => {
    const { model, proposer, sleptMs } = makeRetryingProposer([proposalJson()]);
    const result = await proposer.propose(makeProposeRequest());
    expect(model.requests).toHaveLength(1);
    expect(sleptMs).toEqual([]);
    expect(result.confidence).toBeCloseTo(0.7, 5);
    expect((result.patch.metadata?.diagnostics as string[]).join(' ')).not.toContain('transport retry');
  });

  it('retries once after a 429 and succeeds, with the backoff recorded in diagnostics', async () => {
    const { model, proposer, sleptMs } = makeRetryingProposer([httpError(429), proposalJson()]);
    const result = await proposer.propose(makeProposeRequest());

    expect(model.requests).toHaveLength(2);
    expect(sleptMs).toEqual([500]);
    // Both attempts carried the SAME rendered request (no re-render, no drift).
    expect(model.requests[1]).toEqual(model.requests[0]);
    expect(result.confidence).toBeCloseTo(0.7, 5);
    const diagnostics = (result.patch.metadata?.diagnostics as string[]).join(' | ');
    expect(diagnostics).toContain('proposal transport retry: attempt 1 failed with GatewayHttpError (HTTP_429)');
    expect(diagnostics).toContain('retried after backoff');
  });

  it('retries a network reset (Node E-code) and succeeds', async () => {
    const reset: Error & { code: string } = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const { model, proposer } = makeRetryingProposer([reset, proposalJson()]);
    const result = await proposer.propose(makeProposeRequest());
    expect(model.requests).toHaveLength(2);
    const diagnostics = (result.patch.metadata?.diagnostics as string[]).join(' | ');
    expect(diagnostics).toContain('attempt 1 failed with Error; retried after backoff');
  });

  it('gives up after the bounded retries when the transport error persists (5xx)', async () => {
    const { model, proposer, sleptMs } = makeRetryingProposer([httpError(503), httpError(503), httpError(503)]);
    await expect(proposer.propose(makeProposeRequest())).rejects.toMatchObject({
      name: 'GatewayHttpError',
      status: 503
    });
    expect(model.requests).toHaveLength(2);
    expect(sleptMs).toEqual([500]);
  });

  it('does NOT retry a 4xx: the error propagates untouched', async () => {
    const { model, proposer, sleptMs } = makeRetryingProposer([httpError(400), proposalJson()]);
    await expect(proposer.propose(makeProposeRequest())).rejects.toMatchObject({
      name: 'GatewayHttpError',
      status: 400
    });
    expect(model.requests).toHaveLength(1);
    expect(sleptMs).toEqual([]);
  });

  it('does NOT retry budget denial or purpose mismatch (metered adapter failures)', async () => {
    // A METERED_MODEL_BUDGET_DENIED surfaces as MeteredModelError; whatever its
    // shape, a plain Error without transport evidence must not be retried.
    const { model, proposer, sleptMs } = makeRetryingProposer([
      new Error('[METERED_MODEL_BUDGET_DENIED] ledger refused the reservation'),
      proposalJson()
    ]);
    await expect(proposer.propose(makeProposeRequest())).rejects.toThrow(/METERED_MODEL_BUDGET_DENIED/);
    expect(model.requests).toHaveLength(1);
    expect(sleptMs).toEqual([]);
  });

  it('does NOT retry validation failures: unparseable output stays a typed error', async () => {
    const { model, proposer, sleptMs } = makeRetryingProposer(['not json at all', proposalJson()]);
    await expect(proposer.propose(makeProposeRequest())).rejects.toBeInstanceOf(Harness2ProposalError);
    expect(model.requests).toHaveLength(1);
    expect(sleptMs).toEqual([]);
  });

  it('does NOT retry when the abort signal is already set', async () => {
    const controller = new AbortController();
    controller.abort();
    const { model, proposer, sleptMs } = makeRetryingProposer([httpError(429), proposalJson()]);
    const request = makeProposeRequest({
      metadata: { signal: controller.signal }
    });
    // The first failure observes the aborted signal and rethrows instead of
    // scheduling the retry.
    await expect(proposer.propose(request)).rejects.toMatchObject({ status: 429 });
    expect(model.requests).toHaveLength(1);
    expect(sleptMs).toEqual([]);
  });

  it('does NOT retry when the abort signal fires during the backoff', async () => {
    const controller = new AbortController();
    const { model, proposer } = makeRetryingProposer([httpError(503), proposalJson()], {
      sleep: async () => {
        // The slot was withdrawn while the retry backoff was pending.
        controller.abort();
      }
    });
    const request = makeProposeRequest({ metadata: { signal: controller.signal } });
    // The ORIGINAL model error is rethrown (not the timer error, not undefined).
    await expect(proposer.propose(request)).rejects.toMatchObject({ status: 503 });
    expect(model.requests).toHaveLength(1);
  });

  it('retries the multi-candidate call on a transport error too', async () => {
    const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
      JSON.parse(proposalJson(overrides)) as Record<string, unknown>;
    const set = JSON.stringify([
      payload({ rationale: 'A.', edits: { guardrails: { kind: 'guardrails', formatContract: 'A' } } })
    ]);
    const { model, proposer, sleptMs } = makeRetryingProposer([httpError(429), set]);
    const result = await proposer.proposeCandidates!(makeProposeRequest({ candidateCount: 2 }));
    expect(model.requests).toHaveLength(2);
    expect(sleptMs).toEqual([500]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.rationale).toBe('A.');
    const diagnostics = (result.candidates[0]?.patch.metadata?.diagnostics as string[]).join(' | ');
    expect(diagnostics).toContain('proposal transport retry: attempt 1 failed with GatewayHttpError (HTTP_429)');
  });

  it('keeps byte-for-byte determinism for identical inputs (retry machinery adds nothing)', async () => {
    const request = makeProposeRequest();
    const first = await makeRetryingProposer([proposalJson()]).proposer.propose(request);
    const second = await makeRetryingProposer([proposalJson()]).proposer.propose(request);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  // rev8 integration fix (independent-review P1): the orchestrator now forwards
  // the run-level cancel signal on the ProposeRequest metadata channel. These
  // tests consume exactly that channel shape (`metadata.signal`) so a regression
  // in the forwarding (or in the channel contract itself) fails here.
  it('does not retry a cancelled run: signal rides metadata.signal (orchestrator channel)', async () => {
    const controller = new AbortController();
    // The orchestrator forwards `metadata: { signal }` and the job-book cancels
    // the run WHILE the first attempt is in flight: the second attempt is never
    // scheduled and no backoff is slept.
    const { model, proposer, sleptMs } = makeRetryingProposer([httpError(429), proposalJson()], {
      sleep: async () => {
        controller.abort();
      }
    });
    const request = makeProposeRequest({ metadata: { signal: controller.signal } });
    await expect(proposer.propose(request)).rejects.toMatchObject({ status: 429 });
    expect(model.requests).toHaveLength(1);
    expect(sleptMs).toEqual([]);
  });

  it('proposeCandidates honours the same metadata.signal channel', async () => {
    const controller = new AbortController();
    const payload = JSON.parse(proposalJson()) as Record<string, unknown>;
    const set = JSON.stringify([
      { ...payload, edits: { guardrails: { kind: 'guardrails', formatContract: 'A' } } }
    ]);
    const { model, proposer, sleptMs } = makeRetryingProposer([httpError(429), set], {
      sleep: async () => {
        controller.abort();
      }
    });
    const request = makeProposeRequest({
      candidateCount: 2,
      metadata: { signal: controller.signal }
    });
    await expect(proposer.proposeCandidates!(request)).rejects.toMatchObject({ status: 429 });
    expect(model.requests).toHaveLength(1);
    expect(sleptMs).toEqual([]);
  });
});
