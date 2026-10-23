/**
 * P1-1 action normalizer golden tests.
 *
 * Covers: surface order independence and dedupe, structural patch signatures,
 * the plan section 6.2 example, secret/long-literal redaction, tool argument
 * shapes, and 100x determinism.
 */
import { describe, expect, it } from 'vitest';
import type {
  EightSurfaceEdits,
  EightSurfacePatch,
  HarnessComponentKey
} from '../../../src/types/contracts';
import {
  normalizeMetaAction,
  normalizePatchSignature,
  normalizeToolActionKey
} from '../../../src/jitrl/action-normalizer';

function patch(
  edits: EightSurfaceEdits,
  overrides: Partial<EightSurfacePatch> = {}
): EightSurfacePatch {
  return {
    id: 'patch-1',
    sessionId: 'session-1',
    branchId: 'branch-1',
    origin: 'reference',
    purpose: 'initial',
    guidance: 'memory',
    label: 'label',
    rationale: 'rationale',
    edits,
    createdAt: 1_700_000_000_000,
    ...overrides
  };
}

const ALL_SURFACES: readonly HarnessComponentKey[] = [
  'system_prompt',
  'guardrails',
  'memory',
  'tool_guidance',
  'skills',
  'scripts',
  'subagents',
  'plugins'
];

describe('normalizeMetaAction', () => {
  it('returns only the slot when no surfaces are focused', () => {
    expect(normalizeMetaAction('exploit', [])).toBe('slot:exploit');
    expect(normalizeMetaAction('explore_invariant', [])).toBe(
      'slot:explore_invariant'
    );
  });

  it('sorts, dedupes and joins surfaces', () => {
    expect(
      normalizeMetaAction('explore_domain', ['skills', 'guardrails', 'skills'])
    ).toBe('slot:explore_domain/surf:guardrails+skills');
  });

  it('handles all eight surfaces deterministically', () => {
    expect(normalizeMetaAction('recover', ALL_SURFACES)).toBe(
      'slot:recover/surf:guardrails+memory+plugins+scripts+skills+subagents+system_prompt+tool_guidance'
    );
  });

  it('rejects invalid slots and surface names', () => {
    expect(() => normalizeMetaAction('bogus' as never, [])).toThrow(RangeError);
    expect(() =>
      normalizeMetaAction('exploit', ['bogus' as never])
    ).toThrow(RangeError);
  });
});

describe('normalizePatchSignature', () => {
  it('returns noop for an empty patch', () => {
    expect(normalizePatchSignature(patch({}))).toBe('noop');
    expect(normalizePatchSignature(undefined as never)).toBe('noop');
  });

  it('matches the section 6.2 example', () => {
    const signature = normalizePatchSignature(
      patch({
        guardrails: {
          kind: 'guardrails',
          toolPreconditions: [{ toolName: 'shell', rule: 'no destructive commands' }]
        },
        tool_guidance: {
          kind: 'tool_guidance',
          descriptions: { edit_file: 'Prefer targeted edits.' }
        }
      })
    );
    expect(signature).toBe(
      'guardrails:precondition(shell)+tool_guidance:rewrite(edit_file)'
    );
  });

  it('is independent of surface insertion order', () => {
    const forward = normalizePatchSignature(
      patch({
        guardrails: {
          kind: 'guardrails',
          toolPreconditions: [{ toolName: 'shell', rule: 'r' }]
        },
        tool_guidance: {
          kind: 'tool_guidance',
          descriptions: { edit_file: 'd' }
        }
      })
    );
    const reversed = normalizePatchSignature(
      patch({
        tool_guidance: {
          kind: 'tool_guidance',
          descriptions: { edit_file: 'd' }
        },
        guardrails: {
          kind: 'guardrails',
          toolPreconditions: [{ toolName: 'shell', rule: 'r' }]
        }
      })
    );
    expect(reversed).toBe(forward);
  });

  it('ignores patch identity and timestamp metadata', () => {
    const edits: EightSurfaceEdits = {
      skills: {
        kind: 'skills',
        skills: [{ name: 'schema-migration', markdown: '# SOP' }]
      }
    };
    const first = normalizePatchSignature(
      patch(edits, { id: 'p1', branchId: 'b1', sessionId: 's1', createdAt: 1 })
    );
    const second = normalizePatchSignature(
      patch(edits, {
        id: 'p2',
        branchId: 'b2',
        sessionId: 's2',
        createdAt: 2,
        rationale: 'different rationale'
      })
    );
    expect(second).toBe(first);
  });

  it('produces different signatures for different semantic patches', () => {
    const skills = normalizePatchSignature(
      patch({
        skills: {
          kind: 'skills',
          skills: [{ name: 'schema-migration', markdown: '# SOP' }]
        }
      })
    );
    const scripts = normalizePatchSignature(
      patch({
        scripts: {
          kind: 'scripts',
          scripts: [
            { path: 'schema-migration.py', language: 'python', code: 'print(1)' }
          ]
        }
      })
    );
    expect(skills).not.toBe(scripts);
  });

  it('sorts multiple skills by name', () => {
    const signature = normalizePatchSignature(
      patch({
        skills: {
          kind: 'skills',
          skills: [
            { name: 'zeta-skill', markdown: '# z' },
            { name: 'alpha-skill', markdown: '# a' }
          ]
        }
      })
    );
    expect(signature).toBe('skills:mount(alpha-skill)+skills:mount(zeta-skill)');
  });

  it('reduces script paths to their stem category', () => {
    const signature = normalizePatchSignature(
      patch({
        scripts: {
          kind: 'scripts',
          scripts: [
            { path: 'C:\\work\\foo.py', language: 'python', code: 'x' },
            { path: 'src/bar.ts', language: 'typescript', code: 'y' }
          ]
        }
      })
    );
    expect(signature).toBe('scripts:mount(bar)+scripts:mount(foo)');
  });

  it('extracts subagent names and middleware hooks', () => {
    const signature = normalizePatchSignature(
      patch({
        subagents: {
          kind: 'subagents',
          agents: [{ name: 'reviewer', description: 'reviews diffs' }]
        },
        plugins: {
          kind: 'plugins',
          middleware: [
            {
              name: 'audit',
              hook: 'after_tool',
              language: 'typescript',
              code: 'export {}'
            }
          ]
        }
      })
    );
    expect(signature).toBe(
      'plugins:middleware(after_tool:audit)+subagents:register(reviewer)'
    );
  });

  it('treats memory scoped view ids as presence-only and sorts recall tags', () => {
    const first = normalizePatchSignature(
      patch({
        memory: {
          kind: 'memory',
          scopedViewId: 'branch-a',
          workingNotes: ['one', 'two'],
          recallTags: ['B', 'a']
        }
      })
    );
    const second = normalizePatchSignature(
      patch({
        memory: {
          kind: 'memory',
          scopedViewId: 'branch-b',
          workingNotes: ['three', 'four'],
          recallTags: ['a', 'B']
        }
      })
    );
    expect(first).toBe(
      'memory:notes(2)+memory:scope(branch)+memory:tag(a)+memory:tag(b)'
    );
    expect(second).toBe(first);
  });

  it('encodes system prompt mode and segment', () => {
    expect(
      normalizePatchSignature(
        patch({
          system_prompt: {
            kind: 'system_prompt',
            mode: 'append',
            segment: 'diff-review',
            content: 'x'
          }
        })
      )
    ).toBe('system_prompt:append(diff-review)');
    expect(
      normalizePatchSignature(
        patch({
          system_prompt: { kind: 'system_prompt', mode: 'replace', content: 'x' }
        })
      )
    ).toBe('system_prompt:replace(default)');
  });

  it('encodes guardrails structure without concrete rule text', () => {
    const signature = normalizePatchSignature(
      patch({
        guardrails: {
          kind: 'guardrails',
          appendRules: ['rule one', 'rule two'],
          forbiddenActions: ['rm -rf /'],
          formatContract: 'Return a JSON object',
          toolPreconditions: [{ toolName: 'shell', rule: 'no sudo' }]
        }
      })
    );
    expect(signature).toBe(
      'guardrails:append(2)+guardrails:forbid(1)+guardrails:format(json)+guardrails:precondition(shell)'
    );
    expect(signature).not.toContain('rm -rf');
    expect(signature).not.toContain('no sudo');
  });

  it('redacts secret-looking and over-long key objects', () => {
    const signature = normalizePatchSignature(
      patch({
        skills: {
          kind: 'skills',
          skills: [
            { name: 'sk-abcdef1234567890', markdown: '# secret' },
            {
              name: 'this-is-a-very-long-skill-name-over-24-chars',
              markdown: '# long'
            }
          ]
        }
      })
    );
    expect(signature).toBe('skills:mount(redacted)');
    expect(signature).not.toContain('sk-abcdef');
    expect(signature).not.toContain('very-long');
  });

  it('handles tool-guidance examples and priority order', () => {
    const signature = normalizePatchSignature(
      patch({
        tool_guidance: {
          kind: 'tool_guidance',
          descriptions: { edit_file: 'd' },
          examples: [{ toolName: 'edit_file', example: 'e' }],
          priorityOrder: ['edit_file', 'shell']
        }
      })
    );
    expect(signature).toBe(
      'tool_guidance:example(edit_file)+tool_guidance:priority(2)+tool_guidance:rewrite(edit_file)'
    );
  });
});

describe('normalizeToolActionKey', () => {
  it('returns only the tool name when no input is supplied', () => {
    expect(normalizeToolActionKey('shell')).toBe('tool:shell');
    expect(normalizeToolActionKey('Read_File')).toBe('tool:read_file');
  });

  it('keeps only the leading command name for command arguments', () => {
    expect(normalizeToolActionKey('shell', { cmd: 'pnpm test --filter x' })).toBe(
      'tool:shell(cmd=pnpm*)'
    );
    expect(
      normalizeToolActionKey('shell', { cmd: 'C:\\bin\\pnpm.exe test' })
    ).toBe('tool:shell(cmd=pnpm*)');
    expect(normalizeToolActionKey('shell', { cmd: '/usr/local/bin/node x.js' })).toBe(
      'tool:shell(cmd=node*)'
    );
  });

  it('never stores secret values or long literals', () => {
    expect(
      normalizeToolActionKey('http', { authorization: 'Bearer abc123' })
    ).toBe('tool:http(authorization=redacted)');
    expect(normalizeToolActionKey('http', { apiKey: 'sk-live-abcdef123456' })).toBe(
      'tool:http(apiKey=redacted)'
    );
    expect(normalizeToolActionKey('echo', { note: 'sk-live-abcdef123456' })).toBe(
      'tool:echo(note=redacted)'
    );
    // A 40-char hex-like run is treated as a possible credential digest.
    expect(
      normalizeToolActionKey('echo', { prompt: 'a'.repeat(40) })
    ).toBe('tool:echo(prompt=redacted)');
    expect(
      normalizeToolActionKey('echo', { prompt: 'plain prose '.repeat(5) })
    ).toBe('tool:echo(prompt=str)');
    // The whole command is redacted when it embeds a credential shape.
    expect(
      normalizeToolActionKey('shell', { cmd: 'curl -H "Authorization: Bearer abc123" x' })
    ).toBe('tool:shell(cmd=redacted)');
  });

  it('sorts keys and encodes coarse argument shapes', () => {
    expect(
      normalizeToolActionKey('fs', {
        verbose: true,
        retries: 3,
        paths: ['a', 'b']
      })
    ).toBe('tool:fs(paths=[...],retries=#,verbose=bool)');
    expect(normalizeToolActionKey('fs', { config: { nested: true } })).toBe(
      'tool:fs(config={...})'
    );
    expect(normalizeToolActionKey('fs', {})).toBe('tool:fs(arg={...})');
  });

  it('encodes primitive inputs as arg shapes', () => {
    expect(normalizeToolActionKey('echo', 'hello world')).toBe('tool:echo(arg=str)');
    expect(normalizeToolActionKey('calc', 42)).toBe('tool:calc(arg=#)');
    expect(normalizeToolActionKey('flag', false)).toBe('tool:flag(arg=bool)');
    expect(normalizeToolActionKey('nothing', null)).toBe('tool:nothing(arg=null)');
  });

  it('redacts secret-looking or over-long tool names', () => {
    expect(normalizeToolActionKey('sk-abcdef1234567890')).toBe('tool:redacted');
    expect(
      normalizeToolActionKey('this-is-a-very-long-tool-name-over-24-chars')
    ).toBe('tool:redacted');
  });

  it('is deterministic across 100 repeated calls', () => {
    const samplePatch = patch({
      guardrails: {
        kind: 'guardrails',
        toolPreconditions: [{ toolName: 'shell', rule: 'r' }]
      },
      skills: {
        kind: 'skills',
        skills: [{ name: 'schema-migration', markdown: '# SOP' }]
      }
    });
    const first = {
      meta: normalizeMetaAction('exploit', ['skills', 'guardrails']),
      patch: normalizePatchSignature(samplePatch),
      tool: normalizeToolActionKey('shell', { cmd: 'pnpm test', cwd: '/repo' })
    };
    for (let index = 0; index < 100; index += 1) {
      expect({
        meta: normalizeMetaAction('exploit', ['skills', 'guardrails']),
        patch: normalizePatchSignature(samplePatch),
        tool: normalizeToolActionKey('shell', { cmd: 'pnpm test', cwd: '/repo' })
      }).toEqual(first);
    }
  });
});
