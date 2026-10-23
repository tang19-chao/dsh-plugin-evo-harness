/**
 * P1-1 state abstraction golden tests.
 *
 * Covers: deterministic signature derivation with instance stripping, explicit
 * signature precedence, bucket edges, the full section 6.1 meta token set,
 * defaults/sanitization, proposal and host states, and 100x determinism.
 */
import { describe, expect, it } from 'vitest';
import type {
  FailureSignal,
  ProbeTask
} from '../../../src/types/contracts';
import {
  abstractHostState,
  abstractMetaState,
  abstractProposalState,
  bucketize,
  MAX_TASK_SIGNATURE_LENGTH,
  normalizeSignature,
  sanitizeExplicitSignature,
  type HostStateInput,
  type MetaStateInput,
  type ProposalStateInput
} from '../../../src/jitrl/state-abstraction';

function task(prompt: string, overrides: Partial<ProbeTask> = {}): ProbeTask {
  return { id: 'task-1', prompt, ...overrides };
}

function baseMeta(overrides: Partial<MetaStateInput> = {}): MetaStateInput {
  return {
    task: task('Implement a JSON parser for config files'),
    round: 0,
    parentDepth: 0,
    memoryConfidence: 0,
    referenceStatus: 'missing',
    ...overrides
  };
}

function signal(kind: FailureSignal['kind']): FailureSignal {
  return { kind, message: 'observed ' + kind };
}

function tokenStartingWith(tokens: readonly string[], prefix: string): string {
  const token = tokens.find((candidate) => candidate.startsWith(prefix));
  expect(token).toBeDefined();
  return token as string;
}

describe('normalizeSignature', () => {
  it('trusts an explicit taskSignature verbatim after trimming', () => {
    expect(
      normalizeSignature(task('ignored prompt', { taskSignature: '  OrderFlow/v2  ' }))
    ).toBe('OrderFlow/v2');
  });

  it('falls back to prompt derivation when the explicit signature is empty', () => {
    expect(normalizeSignature(task('Fix the login bug', { taskSignature: '   ' }))).toBe(
      'fix-login-bug'
    );
  });

  it('returns "unknown" for an empty prompt', () => {
    expect(normalizeSignature(task(''))).toBe('unknown');
    expect(normalizeSignature(task('   \n  '))).toBe('unknown');
  });

  it('derives the same signature for one task family with different uuids', () => {
    const first = normalizeSignature(
      task('Fix the login bug for user 550e8400-e29b-41d4-a716-446655440000')
    );
    const second = normalizeSignature(
      task('Fix the login bug for user 123e4567-e89b-12d3-a456-426614174000')
    );
    expect(first).toBe('fix-login-bug-user');
    expect(second).toBe(first);
  });

  it('derives the same signature across absolute paths, keeping only the extension category', () => {
    const windows = normalizeSignature(
      task('Implement JSON parser in C:\\work\\a.ts')
    );
    const posix = normalizeSignature(task('Implement JSON parser in /home/bob/b.ts'));
    expect(windows).toBe('implement-parser-fmt.json-ext.ts');
    expect(posix).toBe(windows);
  });

  it('ignores long numbers and quoted literals', () => {
    const first = normalizeSignature(
      task("Summarize report for 20240101 about 'Q3 revenue'")
    );
    const second = normalizeSignature(
      task("Summarize report for 98765432 about 'Q4 costs'")
    );
    expect(first).toBe('summarize-fmt.report');
    expect(second).toBe(first);
  });

  it('is stable across case and whitespace changes', () => {
    expect(normalizeSignature(task('Fix   THE login   bug'))).toBe('fix-login-bug');
    expect(normalizeSignature(task('fix the login bug'))).toBe('fix-login-bug');
  });

  it('separates different task families', () => {
    const parser = normalizeSignature(task('Implement a JSON parser for config files'));
    const migration = normalizeSignature(task('Migrate the billing tables to Postgres'));
    expect(parser).not.toBe(migration);
    expect(migration).toBe('migrate-billing-tables-postgres');
  });

  it('captures the requested output format', () => {
    expect(normalizeSignature(task('Generate a JSON report about parser errors'))).toBe(
      'generate-parser-errors-fmt.json'
    );
    expect(normalizeSignature(task('Write a markdown report about incidents'))).toBe(
      'write-markdown-incidents-fmt.report'
    );
  });

  it('caps leading verbs at two', () => {
    expect(
      normalizeSignature(task('Refactor and rewrite the parser and migrate the schema'))
    ).toBe('refactor-rewrite-parser-schema');
  });

  it('strips relative file names but records their extension category', () => {
    expect(normalizeSignature(task('Update src/config.ts and tests/config.test.ts'))).toBe(
      'update-fmt.test-ext.ts'
    );
  });
});

describe('bucketize', () => {
  const cuts = [0.25, 0.5, 0.75, 0.9] as const;

  it('is inclusive at every cut', () => {
    expect(bucketize(0.24, cuts)).toBe(0);
    expect(bucketize(0.25, cuts)).toBe(1);
    expect(bucketize(0.49, cuts)).toBe(1);
    expect(bucketize(0.5, cuts)).toBe(2);
    expect(bucketize(0.74, cuts)).toBe(2);
    expect(bucketize(0.75, cuts)).toBe(3);
    expect(bucketize(0.89, cuts)).toBe(3);
    expect(bucketize(0.9, cuts)).toBe(4);
    expect(bucketize(1, cuts)).toBe(4);
  });

  it('returns 0 for empty cuts', () => {
    expect(bucketize(0.42, [])).toBe(0);
  });

  it('rejects non-finite values and non-increasing cuts', () => {
    expect(() => bucketize(Number.NaN, cuts)).toThrow(RangeError);
    expect(() => bucketize(0.5, [0.5, 0.25])).toThrow(RangeError);
    expect(() => bucketize(0.5, [0.5, 0.5])).toThrow(RangeError);
    expect(() => bucketize(0.5, [Number.NaN])).toThrow(RangeError);
  });
});

describe('abstractMetaState', () => {
  it('emits the exact section 6.1 token set and bucket', () => {
    const state = abstractMetaState({
      task: task('anything', {
        taskSignature: 'order-flow',
        complexity: 'moderate',
        contextTags: ['zeta', 'Alpha', 'alpha']
      }),
      round: 2,
      parentDepth: 1,
      parentSlot: 'explore_domain',
      parentFailure: { category: 'repairable_implementation' },
      memoryConfidence: 0.6,
      referenceStatus: 'failed',
      referenceToolErrorRate: 0.15,
      referenceFailureSignals: [signal('tool_error'), signal('timeout')]
    });

    expect(state.level).toBe('meta');
    expect(state.bucket).toBe('meta|order-flow|moderate');
    expect(state.tokens).toEqual([
      'sig:order-flow',
      'cx:moderate',
      'tag:alpha',
      'tag:zeta',
      'round:2',
      'depth:1',
      'pslot:explore_domain',
      'pfail:repairable_implementation',
      'mconf:2',
      'ref:failed',
      'terr:2',
      'sig_fail:timeout',
      'sig_fail:tool_error'
    ]);
    expect(state.summary).toBe(state.tokens.join(' '));
  });

  it('defaults optionals deterministically', () => {
    const state = abstractMetaState(
      baseMeta({ task: task('ignored', { taskSignature: 'minimal' }) })
    );
    expect(state.tokens).toEqual([
      'sig:minimal',
      'cx:unknown',
      'round:0',
      'depth:0',
      'pslot:root',
      'pfail:none',
      'mconf:0',
      'ref:missing',
      'terr:0'
    ]);
    expect(state.bucket).toBe('meta|minimal|unknown');
  });

  it('treats a null referenceStatus as missing', () => {
    const state = abstractMetaState(baseMeta({ referenceStatus: null }));
    expect(tokenStartingWith(state.tokens, 'ref:')).toBe('ref:missing');
  });

  it('clamps round and parent depth into 0..4', () => {
    const state = abstractMetaState(baseMeta({ round: 9, parentDepth: 12 }));
    expect(tokenStartingWith(state.tokens, 'round:')).toBe('round:4');
    expect(tokenStartingWith(state.tokens, 'depth:')).toBe('depth:4');
    const negative = abstractMetaState(baseMeta({ round: -3, parentDepth: -1 }));
    expect(tokenStartingWith(negative.tokens, 'round:')).toBe('round:0');
    expect(tokenStartingWith(negative.tokens, 'depth:')).toBe('depth:0');
  });

  it('maps memory-confidence edges into mconf buckets 0..4', () => {
    const cases: readonly (readonly [number, string])[] = [
      [0.24, 'mconf:0'],
      [0.25, 'mconf:1'],
      [0.49, 'mconf:1'],
      [0.5, 'mconf:2'],
      [0.74, 'mconf:2'],
      [0.75, 'mconf:3'],
      [0.89, 'mconf:3'],
      [0.9, 'mconf:4']
    ];
    for (const [confidence, expected] of cases) {
      const state = abstractMetaState(baseMeta({ memoryConfidence: confidence }));
      expect(tokenStartingWith(state.tokens, 'mconf:')).toBe(expected);
    }
  });

  it('maps reference tool-error-rate edges into terr buckets 0..3', () => {
    const cases: readonly (readonly [number, string])[] = [
      [0, 'terr:0'],
      [0.05, 'terr:1'],
      [0.1, 'terr:1'],
      [0.11, 'terr:2'],
      [0.3, 'terr:2'],
      [0.31, 'terr:3']
    ];
    for (const [rate, expected] of cases) {
      const state = abstractMetaState(
        baseMeta({ referenceToolErrorRate: rate })
      );
      expect(tokenStartingWith(state.tokens, 'terr:')).toBe(expected);
    }
  });

  it('produces identical tokens and bucket for the same family with different instance ids and paths', () => {
    const first = abstractMetaState(
      baseMeta({
        task: task('Fix the login bug in C:\\work\\a.ts', {
          id: 'instance-1',
          taskSignature: 'login-bug'
        })
      })
    );
    const second = abstractMetaState(
      baseMeta({
        task: task('Fix the login bug in /home/other/b.ts', {
          id: 'instance-2',
          taskSignature: 'login-bug'
        })
      })
    );
    expect(first.tokens).toEqual(second.tokens);
    expect(first.bucket).toBe(second.bucket);
  });

  it('sorts and dedupes context tags', () => {
    const state = abstractMetaState(
      baseMeta({
        task: task('ignored', {
          taskSignature: 'tags',
          contextTags: ['zeta', 'Alpha', 'alpha', 'backend']
        })
      })
    );
    expect(state.tokens.filter((token) => token.startsWith('tag:'))).toEqual([
      'tag:alpha',
      'tag:backend',
      'tag:zeta'
    ]);
  });

  it('sorts and dedupes failure signal kinds', () => {
    const state = abstractMetaState(
      baseMeta({
        task: task('ignored', { taskSignature: 'signals' }),
        referenceFailureSignals: [
          signal('tool_error'),
          signal('timeout'),
          signal('tool_error')
        ]
      })
    );
    expect(state.tokens.filter((token) => token.startsWith('sig_fail:'))).toEqual([
      'sig_fail:timeout',
      'sig_fail:tool_error'
    ]);
  });

  it('sanitizes invalid optional enum values instead of fragmenting buckets', () => {
    const state = abstractMetaState({
      task: task('ignored', {
        taskSignature: 'sanitized',
        complexity: 'bogus' as never
      }),
      round: 1,
      parentDepth: 1,
      parentSlot: 'bogus' as never,
      parentFailure: { category: 'bogus' as never },
      memoryConfidence: Number.NaN,
      referenceStatus: 'bogus' as never,
      referenceToolErrorRate: Number.NaN
    });
    expect(tokenStartingWith(state.tokens, 'cx:')).toBe('cx:unknown');
    expect(tokenStartingWith(state.tokens, 'pslot:')).toBe('pslot:root');
    expect(tokenStartingWith(state.tokens, 'pfail:')).toBe('pfail:none');
    expect(tokenStartingWith(state.tokens, 'mconf:')).toBe('mconf:0');
    expect(tokenStartingWith(state.tokens, 'ref:')).toBe('ref:missing');
    expect(tokenStartingWith(state.tokens, 'terr:')).toBe('terr:0');
  });

  it('is deterministic across 100 repeated calls', () => {
    const input: MetaStateInput = {
      task: task('Implement a JSON parser for config files', {
        contextTags: ['backend', 'urgent']
      }),
      round: 2,
      parentDepth: 1,
      parentSlot: 'exploit',
      parentFailure: { category: 'weak_underexplored' },
      memoryConfidence: 0.8,
      referenceStatus: 'succeeded',
      referenceToolErrorRate: 0,
      referenceFailureSignals: [signal('no_deliverable')]
    };
    const first = abstractMetaState(input);
    for (let index = 0; index < 100; index += 1) {
      expect(abstractMetaState(input)).toEqual(first);
    }
  });
});

describe('abstractProposalState', () => {
  const baseProposal: ProposalStateInput = {
    task: task('ignored', {
      taskSignature: 'order-flow',
      complexity: 'moderate',
      contextTags: ['backend']
    }),
    round: 1,
    parentDepth: 1,
    parentSlot: 'exploit',
    parentFailure: { category: 'none' },
    memoryConfidence: 0.3,
    referenceStatus: 'failed',
    referenceToolErrorRate: 0.05,
    referenceFailureSignals: [signal('tool_error')],
    slot: 'explore_invariant',
    guidance: 'guidance_free',
    parentPatchSignature: 'guardrails:precondition(shell)'
  };

  it('extends meta tokens with slot, guidance and parent signature', () => {
    const state = abstractProposalState(baseProposal);
    expect(state.level).toBe('proposal');
    expect(state.bucket).toBe(
      'proposal|order-flow|moderate|explore_invariant|guidance_free'
    );
    expect(state.tokens).toContain('sig:order-flow');
    expect(state.tokens).toContain('cx:moderate');
    expect(state.tokens).toContain('slot:explore_invariant');
    expect(state.tokens).toContain('guidance:guidance_free');
    expect(state.tokens).toContain(
      'parent_patch_signature:guardrails-precondition-shell'
    );
    expect(state.summary).toBe(state.tokens.join(' '));
  });

  it('omits the parent signature for root proposals', () => {
    const state = abstractProposalState({
      ...baseProposal,
      parentPatchSignature: '   '
    });
    expect(
      state.tokens.some((token) => token.startsWith('parent_patch_signature:'))
    ).toBe(false);
  });

  it('rejects invalid slot and guidance values', () => {
    expect(() =>
      abstractProposalState({ ...baseProposal, slot: 'bogus' as never })
    ).toThrow(RangeError);
    expect(() =>
      abstractProposalState({ ...baseProposal, guidance: 'bogus' as never })
    ).toThrow(RangeError);
  });
});

describe('abstractHostState', () => {
  it('defaults to a minimal host state', () => {
    const state = abstractHostState({});
    expect(state.level).toBe('host_tool');
    expect(state.tokens).toEqual(['err:none', 'turn:unknown', 'wd:unknown']);
    expect(state.bucket).toBe('host|none|unknown|unknown');
  });

  it('keeps the last three tool names by default', () => {
    const state = abstractHostState({
      recentToolNames: ['read', 'edit', 'shell', 'grep'],
      turnKind: 'completed',
      workingDirCategory: 'Repo Root'
    });
    expect(state.tokens).toEqual([
      'tool:edit',
      'tool:shell',
      'tool:grep',
      'err:none',
      'turn:completed',
      'wd:repo-root'
    ]);
    expect(state.bucket).toBe('host|none|completed|repo-root');
  });

  it('honours a custom window, dedupes tools and slugifies the error class', () => {
    const state = abstractHostState({
      recentToolNames: ['read', 'shell', 'shell'],
      recentWindow: 2,
      lastErrorClass: 'Tool Error!',
      turnKind: 'max_tokens',
      workingDirCategory: 'tmp'
    });
    expect(state.tokens).toEqual([
      'tool:shell',
      'err:tool-error',
      'turn:max_tokens',
      'wd:tmp'
    ]);
  });

  it('sanitizes unknown turn kinds and clamps a zero window to one', () => {
    const state = abstractHostState({
      recentToolNames: ['read', 'shell'],
      recentWindow: 0,
      turnKind: 'nonsense' as never
    });
    expect(state.tokens).toContain('turn:unknown');
    expect(state.tokens).toContain('tool:shell');
    expect(state.tokens).not.toContain('tool:read');
  });

  it('is deterministic across 100 repeated calls', () => {
    const input: HostStateInput = {
      recentToolNames: ['read', 'edit'],
      lastErrorClass: 'tool_error',
      turnKind: 'error',
      workingDirCategory: 'repo'
    };
    const first = abstractHostState(input);
    for (let index = 0; index < 100; index += 1) {
      expect(abstractHostState(input)).toEqual(first);
    }
  });
});

describe('secret scrubbing before tokenization (repair B2)', () => {
  const tokenA = 'ghp_AAAABBBBCCCCDDDDEEEEFFFF0000';
  const tokenB = 'ghp_ZZZZYYYYXXXXWWWWVVVVUUUU9999';
  const promptWith = (token: string): string =>
    'deploy the api service using ' + token + ' against https://user:pw@host/x';

  it('never lets a token or userinfo URL fragment reach tokens, bucket or summary', () => {
    const state = abstractMetaState(baseMeta({ task: task(promptWith(tokenA)) }));
    const rendered = state.tokens.join('\n') + '\n' + state.bucket + '\n' + state.summary;
    expect(rendered).not.toContain('ghp_');
    expect(rendered).not.toContain(tokenA);
    expect(rendered).not.toContain('user:pw');
    expect(state.summary).toBe(state.tokens.join(' '));
  });

  it('maps the same task with a different secret value to the same bucket', () => {
    const first = abstractMetaState(baseMeta({ task: task(promptWith(tokenA)) }));
    const second = abstractMetaState(baseMeta({ task: task(promptWith(tokenB)) }));
    expect(second.bucket).toBe(first.bucket);
    expect(second.tokens).toEqual(first.tokens);
    expect(second.summary).toBe(first.summary);
  });

  it('scrubs secrets from context tags before they become tag tokens', () => {
    const state = abstractMetaState(
      baseMeta({
        task: task('deploy the api service', { contextTags: ['team-token ' + tokenA] })
      })
    );
    const tagTokens = state.tokens.filter((token) => token.startsWith('tag:'));
    expect(tagTokens.join(' ')).not.toContain('ghp_');
  });
});

describe('explicit signature sanitization (P3-F/G2-4)', () => {
  it('redacts a credential inside an explicit taskSignature before it reaches bucket/summary', () => {
    const state = abstractMetaState(
      baseMeta({ task: task('ignored prompt', { taskSignature: 'deploy ghp_AAAABBBBCCCCDDDDEEEEFFFF0000 pipeline' }) })
    );
    const rendered = state.tokens.join('\n') + '\n' + state.bucket + '\n' + state.summary;
    expect(rendered).not.toContain('ghp_');
    expect(state.bucket).toContain('deploy');
  });

  it('maps signatures differing only in the secret value to the same bucket', () => {
    const first = normalizeSignature(task('ignored', { taskSignature: 'deploy ghp_AAAABBBBCCCCDDDDEEEEFFFF0000 pipeline' }));
    const second = normalizeSignature(task('ignored', { taskSignature: 'deploy ghp_ZZZZYYYYXXXXWWWWVVVVUUUU9999 pipeline' }));
    expect(second).toBe(first);
  });

  it('clamps over-long explicit signatures to the documented bound', () => {
    const longSignature = 'word '.repeat(24).trim();
    const sanitized = sanitizeExplicitSignature(longSignature);
    expect(sanitized.clamped).toBe(true);
    expect(sanitized.signature).toHaveLength(MAX_TASK_SIGNATURE_LENGTH);
    expect(sanitized.signature).toBe(longSignature.slice(0, MAX_TASK_SIGNATURE_LENGTH));
    expect(sanitizeExplicitSignature('OrderFlow/v2').clamped).toBe(false);
  });

  it('maps two tasks whose explicit signatures differ only beyond the bound to the same bucket', () => {
    // 'ab cd ' repeats keep every run far below the 43-char blob threshold,
    // so the redaction pass is a no-op and only the clamp matters.
    const segment = 'ab cd '.repeat(17);
    const first = abstractMetaState(baseMeta({ task: task('ignored', { taskSignature: segment + '-AAAA' }) }));
    const second = abstractMetaState(baseMeta({ task: task('ignored', { taskSignature: segment + '-BBBB' }) }));
    expect(second.bucket).toBe(first.bucket);
    expect(second.tokens).toEqual(first.tokens);
    expect(second.summary).toBe(first.summary);
  });

  it('keeps the three real-world keyword collisions distinguishable at signature level', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['fix the token refresh bug', 'fix the token expiry bug'],
      ['secret manager config drift', 'secret rotation policy drift'],
      ['bearer auth layer hardening', 'bearer caching layer hardening']
    ];
    for (const [first, second] of pairs) {
      expect(normalizeSignature(task(first)), first).not.toBe(normalizeSignature(task(second)));
    }
  });
});
