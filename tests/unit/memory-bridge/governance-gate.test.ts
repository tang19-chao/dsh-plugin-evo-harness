/**
 * Client-side governance polyfill: the pre-write deterministic gate.
 * Every rejected lesson must fail before a single backend interaction.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryBridge } from '../../../src/memory-bridge/bridge';
import { validateLessonForWrite } from '../../../src/memory-bridge/governance-polyfill';
import type { CanonicalLesson } from '../../../src/types/contracts';
import { vectorFactServer } from './mocks/mock-mcp';
import {
  BRANCH_A_NS,
  GLOBAL_NS,
  FIXED_NOW,
  branchScope,
  globalLesson,
  memoryConfig,
  negativeLesson,
  sessionScope,
  validLesson
} from './fixtures';

function bridgeWith(config = memoryConfig()) {
  const server = vectorFactServer({ serverId: 'mem0' });
  const bridge = createMemoryBridge({ config, clients: [server.client], now: () => FIXED_NOW });
  return { server, bridge };
}

interface IncompleteCase {
  readonly name: string;
  readonly lesson: CanonicalLesson;
  readonly code: string;
}

const incompleteCases: readonly IncompleteCase[] = [
  { name: 'empty whenToApply', lesson: validLesson({ whenToApply: [] }), code: 'missing_when_to_apply' },
  { name: 'empty whenNotToApply', lesson: validLesson({ whenNotToApply: [] }), code: 'missing_when_not_to_apply' },
  { name: 'empty subFunctions', lesson: validLesson({ subFunctions: [] }), code: 'invalid_sub_functions' },
  {
    name: 'unknown harness surface in subFunctions',
    lesson: validLesson({ subFunctions: ['not_a_surface'] as never }),
    code: 'invalid_sub_functions'
  },
  {
    name: 'blank executionPatch summary',
    lesson: validLesson({ executionPatch: { summary: '   ' } }),
    code: 'invalid_execution_patch'
  },
  {
    name: 'missing probe evidence',
    lesson: validLesson({
      verificationEvidence: {
        referenceFailure: '',
        candidateSuccess: '',
        metricsDelta: { stepsDiff: 0, toolErrorsDiff: 0 }
      }
    }),
    code: 'missing_verification_evidence'
  },
  { name: 'blank lesson id', lesson: validLesson({ id: '' }), code: 'invalid_lesson' },
  { name: 'blank lesson title', lesson: validLesson({ title: '  ' }), code: 'invalid_lesson' }
];

describe('pre-write deterministic gate', () => {
  it.each(incompleteCases)('rejects $name before any backend call', async ({ lesson, code }) => {
    const { server, bridge } = bridgeWith();
    const result = await bridge.commit(lesson, { scope: branchScope() });
    expect(result.accepted).toBe(false);
    expect(result.persisted).toBe(false);
    expect(result.violations.some((violation) => violation.code === code && violation.severity === 'block')).toBe(true);
    expect(server.calls).toHaveLength(0);
    expect(server.listToolsCalls).toBe(0);
  });

  it('accepts a complete lesson and only then touches the backend', async () => {
    const { server, bridge } = bridgeWith();
    const result = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(result.accepted).toBe(true);
    expect(result.persisted).toBe(true);
    expect(server.callsTo('add_memory')).toHaveLength(1);
  });

  it('validates embedded script syntax before writing', async () => {
    const { server, bridge } = bridgeWith();
    const broken = validLesson({
      metadata: {
        embeddedScripts: [{ path: 'helpers/gen.py', language: 'python', code: 'def collect(items):\n    return items[' }]
      }
    });
    const result = await bridge.commit(broken, { scope: branchScope() });
    expect(result.accepted).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain('script_syntax_invalid');
    expect(server.calls).toHaveLength(0);
  });

  it('validates generated middleware in the plugins surface diff', async () => {
    const { server, bridge } = bridgeWith();
    const middleware = JSON.stringify([
      { name: 'guard', hook: 'before_tool', language: 'typescript', code: 'export const guard = (ctx) => {' }
    ]);
    const broken = validLesson({
      executionPatch: { summary: 'mount a guard middleware', componentDiffs: { plugins: middleware } }
    });
    const result = await bridge.commit(broken, { scope: branchScope() });
    expect(result.accepted).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain('script_syntax_invalid');
    expect(server.calls).toHaveLength(0);
  });

  it('rejects traversal script paths', async () => {
    const { bridge } = bridgeWith();
    const broken = validLesson({
      metadata: { embeddedScripts: [{ path: '../../etc/evil.sh', language: 'bash', code: 'echo ok' }] }
    });
    const result = await bridge.commit(broken, { scope: branchScope() });
    expect(result.accepted).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain('invalid_script_path');
  });

  it('accepts a syntactically valid embedded script', async () => {
    const { bridge, server } = bridgeWith();
    const lesson = validLesson({
      metadata: {
        embeddedScripts: [
          { path: 'helpers/collect.py', language: 'python', code: 'import json\n\ndef collect(items):\n    return json.dumps(items)\n' }
        ]
      }
    });
    const result = await bridge.commit(lesson, { scope: branchScope() });
    expect(result.accepted).toBe(true);
    expect(server.callsTo('add_memory')).toHaveLength(1);
  });

  it('blocks a globally visible lesson written into a branch scope', async () => {
    const { server, bridge } = bridgeWith();
    const result = await bridge.commit(globalLesson({ sessionId: 's-1' }), { scope: branchScope() });
    expect(result.accepted).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain('namespace_violation');
    expect(server.calls).toHaveLength(0);
  });

  it('blocks a lesson from another session (cross-session poisoning)', async () => {
    const { bridge } = bridgeWith();
    const result = await bridge.commit(validLesson({ sessionId: 's-other' }), { scope: branchScope('s-1', 'b-1') });
    expect(result.accepted).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain('scope_violation');
  });

  it('blocks a lesson whose branchId contradicts the target branch', async () => {
    const { bridge } = bridgeWith();
    const result = await bridge.commit(validLesson({ branchId: 'b-9' }), { scope: branchScope('s-1', 'b-1') });
    expect(result.accepted).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain('namespace_violation');
  });

  it('blocks a branch-private lesson written into global scope', async () => {
    const { bridge } = bridgeWith();
    const result = await bridge.commit(validLesson(), { scope: { kind: 'global' } });
    expect(result.accepted).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain('scope_violation');
  });

  it('allows session-visible lessons inside the same session scope', async () => {
    const { bridge, server } = bridgeWith();
    const lesson = validLesson({ visibility: 'session', branchId: undefined, id: 'L-session' });
    const result = await bridge.commit(lesson, { scope: sessionScope('s-1') });
    expect(result.accepted).toBe(true);
    expect(result.namespace).toBe('harness2:session:s-1');
    expect(server.callsTo('add_memory')).toHaveLength(1);
  });

  it('blocks a negative lesson asked to be injected as a recommendation', async () => {
    const { bridge } = bridgeWith();
    const leak = negativeLesson({ id: 'L-leak', metadata: { injectAsRecommendation: true } });
    const result = await bridge.commit(leak, { scope: branchScope() });
    expect(result.accepted).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain('negative_polarity_leak');
  });

  it('flags a duplicate lesson id as a warning without blocking', async () => {
    const { bridge, server } = bridgeWith();
    expect((await bridge.commit(validLesson(), { scope: branchScope() })).accepted).toBe(true);
    const second = await bridge.commit(validLesson(), { scope: branchScope() });
    expect(second.accepted).toBe(true);
    expect(second.violations.map((violation) => violation.code)).toContain('duplicate_lesson');
    expect(second.violations.find((violation) => violation.code === 'duplicate_lesson')?.severity).toBe('warn');
    expect(server.callsTo('add_memory')).toHaveLength(2);
  });

  it('honours dryRun without touching the backend', async () => {
    const { bridge, server } = bridgeWith();
    const result = await bridge.commit(validLesson(), { scope: branchScope(), dryRun: true });
    expect(result.accepted).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.namespace).toBe(BRANCH_A_NS);
    expect(server.calls).toHaveLength(0);
    expect(server.listToolsCalls).toBe(0);
  });

  it('downgrades completeness violations to warnings when the polyfill is disabled', async () => {
    const { bridge, server } = bridgeWith(memoryConfig({ enableGovernancePolyfill: false }));
    const result = await bridge.commit(validLesson({ whenToApply: [], whenNotToApply: [] }), {
      scope: branchScope()
    });
    expect(result.accepted).toBe(true);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.every((violation) => violation.severity === 'warn')).toBe(true);
    expect(server.callsTo('add_memory')).toHaveLength(1);
  });

  it('downgrades missing evidence when requireEvidence is false', async () => {
    const { bridge } = bridgeWith(memoryConfig({ requireEvidence: false }));
    const result = await bridge.commit(
      validLesson({
        verificationEvidence: {
          referenceFailure: '',
          candidateSuccess: '',
          metricsDelta: { stepsDiff: 0, toolErrorsDiff: 0 }
        }
      }),
      { scope: branchScope() }
    );
    expect(result.accepted).toBe(true);
    const finding = result.violations.find((violation) => violation.code === 'missing_verification_evidence');
    expect(finding?.severity).toBe('warn');
  });

  it('reports the gate split (blocking vs warning) for a pure validation call', () => {
    const gate = validateLessonForWrite({
      lesson: validLesson({ whenToApply: [], id: 'L-dup' }),
      scope: branchScope(),
      config: memoryConfig(),
      namespace: BRANCH_A_NS,
      existingLessonIds: new Set(['L-dup'])
    });
    expect(gate.accepted).toBe(false);
    expect(gate.blocking.map((violation) => violation.code)).toEqual(['missing_when_to_apply']);
    expect(gate.warnings.map((violation) => violation.code)).toEqual(['duplicate_lesson']);
  });

  it('uses the deterministic global namespace for global commits', async () => {
    const { bridge } = bridgeWith();
    const result = await bridge.commit(globalLesson(), { scope: { kind: 'global' } });
    expect(result.accepted).toBe(true);
    expect(result.namespace).toBe(GLOBAL_NS);
  });
});
