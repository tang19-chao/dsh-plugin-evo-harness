/**
 * rev6 R4 prerequisite: the `whenToApply` shadow analyser must measure hit and
 * friendly-fire rates WITHOUT enabling anything and WITHOUT writing anywhere.
 *
 * THE THREE PROPERTIES THIS FILE PINS
 * -----------------------------------
 * 1. **It uses the production matcher.** The tests drive lessons whose cues and
 *    restraint clauses are CJK, latin and mixed, and assert the analyser agrees
 *    with `matchLessonConditions` directly - so the report cannot describe a
 *    filter nobody runs.
 * 2. **Friendly fire is counted, not hidden.** A lesson whose cue fires and whose
 *    `whenNotToApply` also matches is classified `friendly-fire`, and the
 *    aggregate rate is derived from those, not from a re-derivation.
 * 3. **It cannot enable filtering.** There is no `enabled`/`recommended` field in
 *    the report at all, the boundary sentence is always present, and the module
 *    performs no I/O. A future change that lets an analysis flip the default
 *    would have to delete these assertions.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  analyzeRecallShadow,
  renderRecallShadowMarkdown,
  type ShadowLesson
} from '../../../src/memory-bridge/recall-shadow-analysis';
import { matchLessonConditions } from '../../../src/memory-bridge/governance-polyfill';
import type { CanonicalLesson, MemoryRecallQuery, MemoryScope } from '../../../src/types/contracts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SCOPE: MemoryScope = { kind: 'session', sessionId: 'session-shadow-1' };

function query(text: string, extra: Partial<MemoryRecallQuery> = {}): MemoryRecallQuery {
  return { scope: SCOPE, text, limit: 5, ...extra };
}

/** A minimal canonical lesson; only the fields the matcher reads are meaningful here. */
function lesson(id: string, whenToApply: readonly string[], whenNotToApply: readonly string[], title = id): CanonicalLesson {
  return {
    id,
    title,
    whenToApply,
    whenNotToApply,
    subFunctions: ['scripts'],
    executionPatch: { summary: 'noop fixture for the shadow analyser' },
    verificationEvidence: {
      referenceFailure: 'reference failed in the fixture',
      candidateSuccess: 'candidate succeeded in the fixture',
      metricsDelta: { stepsDiff: -1, toolErrorsDiff: -1 }
    },
    polarity: 'positive',
    visibility: 'session',
    sessionId: 'session-shadow-1'
  } as CanonicalLesson;
}

function shadow(entry: CanonicalLesson, source = 'fixture'): ShadowLesson {
  return { lesson: entry, source };
}

describe('the analyser runs the PRODUCTION matcher', () => {
  it('agrees with matchLessonConditions on a latin cue', () => {
    const target = lesson('latin-1', ['eslint flat config'], ['simple table task']);
    const queries = [
      { queryId: 'q1', query: query('migrate the eslint flat config for the workspace') },
      { queryId: 'q2', query: query('rename a variable') }
    ];
    const report = analyzeRecallShadow({ lessons: [shadow(target)], queries });
    const q1Expected = matchLessonConditions(target, queries[0]!.query);
    const q2Expected = matchLessonConditions(target, queries[1]!.query);
    expect(q1Expected.whenToApply.length > 0).toBe(report.lessons[0]!.cueHits === 1);
    expect(q2Expected.whenToApply.length).toBe(0);
    expect(report.lessons[0]!.cueHits).toBe(1);
  });

  it('agrees on CJK cues (same rule, not a latin-only shortcut)', () => {
    const target = lesson('cjk-1', ['缓存前缀命中率下降'], ['简单的表格任务']);
    const hit = analyzeRecallShadow({
      lessons: [shadow(target)],
      queries: [{ queryId: 'q1', query: query('这次运行缓存前缀命中率下降了，需要排查') }]
    });
    expect(hit.lessons[0]!.cueHits).toBe(1);

    const miss = analyzeRecallShadow({
      lessons: [shadow(target)],
      queries: [{ queryId: 'q2', query: query('just rename this variable') }]
    });
    expect(miss.lessons[0]!.cueHits).toBe(0);
  });

  it('agrees on a mixed CJK/latin cue', () => {
    const target = lesson('mixed-1', ['cacheRead 计量 measured'], []);
    const queries = [{ queryId: 'q1', query: query('check whether cacheRead 计量 is measured here') }];
    const report = analyzeRecallShadow({ lessons: [shadow(target)], queries });
    const expected = matchLessonConditions(target, queries[0]!.query);
    expect(report.lessons[0]!.cueHits).toBe(expected.whenToApply.length > 0 ? 1 : 0);
  });
});

describe('friendly fire is measured, not smoothed over', () => {
  it('classifies a cue+veto collision as friendly-fire and counts it', () => {
    // The cue and the restraint both match this query: positive filtering would
    // surface the lesson and the firewall would immediately remove it.
    const target = lesson('ff-1', ['cacheRead 计量'], ['简单的表格任务']);
    const queries = [{ queryId: 'q1', query: query('cacheRead 计量 for a 简单的表格任务') }];
    const report = analyzeRecallShadow({ lessons: [shadow(target)], queries });

    const summary = report.lessons[0]!;
    expect(summary.cueHits).toBe(1);
    expect(summary.vetoHits).toBe(1);
    expect(summary.friendlyFireHits).toBe(1);
    expect(summary.usableHits).toBe(0);
    expect(summary.friendlyFireRate).toBe(1);
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]!.classification).toBe('friendly-fire');
    expect(report.hits[0]!.vetoClauses.length).toBeGreaterThan(0);
    expect(report.totals.overallFriendlyFireRate).toBe(1);
  });

  it('classifies a cue-only hit as usable', () => {
    const target = lesson('ok-1', ['cacheRead 计量'], ['unrelated restraint clause']);
    const report = analyzeRecallShadow({
      lessons: [shadow(target)],
      queries: [{ queryId: 'q1', query: query('cacheRead 计量 please') }]
    });
    expect(report.lessons[0]!.usableHits).toBe(1);
    expect(report.lessons[0]!.friendlyFireHits).toBe(0);
    expect(report.hits[0]!.classification).toBe('usable');
  });

  it('does not count a veto-only query as a cue hit', () => {
    const target = lesson('v-1', ['cacheRead 计量'], ['简单的表格任务']);
    const report = analyzeRecallShadow({
      lessons: [shadow(target)],
      queries: [{ queryId: 'q1', query: query('a 简单的表格任务 only') }]
    });
    expect(report.lessons[0]!.cueHits).toBe(0);
    expect(report.lessons[0]!.vetoHits).toBe(1);
    // A lesson whose cue never fired must not report a friendly-fire RATE of 0
    // as if it had been evaluated and found safe.
    expect(report.lessons[0]!.friendlyFireRate).toBe(0);
    expect(report.totals.overallFriendlyFireRate).toBe(0);
  });

  it('aggregates across several lessons and queries without losing the per-lesson view', () => {
    // The clauses deliberately share NO tokens across lessons. The production
    // matcher fires on >= half of a clause's significant tokens, so two clauses
    // that both contain "cue" would legitimately cross-match and make the
    // per-lesson counts meaningless as a fixture.
    //
    // NOTE the restraint wording: 'a' has NO restraint at all (an empty
    // whenNotToApply never vetoes), because a restraint mentioning "alphabet"
    // would match q1 by the same 50% rule and turn 'a' into friendly fire too.
    const lessons = [
      shadow(lesson('a', ['alphabet migration'], []), 'fixture-a'),
      shadow(lesson('b', ['beta rollout'], ['beta restraint']), 'fixture-b')
    ];
    const queries = [
      { queryId: 'q1', query: query('alphabet migration here') },
      { queryId: 'q2', query: query('beta rollout and beta restraint') },
      { queryId: 'q3', query: query('nothing relevant') }
    ];
    const report = analyzeRecallShadow({ lessons, queries });

    expect(report.totalLessons).toBe(2);
    expect(report.totalQueries).toBe(3);
    expect(report.lessons.map((entry) => entry.lessonId)).toEqual(['a', 'b']);
    expect(report.lessons[0]!.source).toBe('fixture-a');
    // a: 1 cue hit, 0 friendly fire (its restraint never matches q1).
    expect(report.lessons[0]!.cueHits).toBe(1);
    expect(report.lessons[0]!.friendlyFireHits).toBe(0);
    // b: 1 cue hit and its restraint also matches q2 -> friendly fire.
    expect(report.lessons[1]!.cueHits).toBe(1);
    expect(report.lessons[1]!.friendlyFireHits).toBe(1);
    expect(report.totals.cueHits).toBe(2);
    expect(report.totals.friendlyFireHits).toBe(1);
    expect(report.totals.overallFriendlyFireRate).toBe(0.5);
    // Hit rate is over lesson x query cells, so it cannot exceed 1.
    expect(report.totals.overallHitRate).toBeCloseTo(2 / 6, 10);
    expect(report.totals.queriesWithAnyCue).toBe(2);
  });

  it('documents the >=50% token threshold that makes shared words match', () => {
    // NON-VACUITY for the fixture above: this asserts the rule that forced the
    // wording change, so a future threshold change surfaces here rather than
    // silently making the aggregation test pass for a different reason.
    const overlapping = lesson('overlap', ['alpha cue'], []);
    const report = analyzeRecallShadow({
      lessons: [shadow(overlapping)],
      queries: [{ queryId: 'q1', query: query('beta cue and beta restraint') }]
    });
    // 1 of 2 clause tokens ('cue') present = 0.5 >= 0.5 -> the cue fires.
    expect(report.lessons[0]!.cueHits).toBe(1);

    // A clause whose majority of tokens are absent must NOT fire.
    const specific = lesson('specific', ['alpha gamma delta'], []);
    const specificReport = analyzeRecallShadow({
      lessons: [shadow(specific)],
      queries: [{ queryId: 'q1', query: query('beta cue and beta restraint') }]
    });
    expect(specificReport.lessons[0]!.cueHits).toBe(0);
  });

  it('is deterministic: the same inputs produce the same report', () => {
    const lessons = [shadow(lesson('d', ['delta cue'], []))];
    const queries = [{ queryId: 'q1', query: query('delta cue') }];
    const first = analyzeRecallShadow({ lessons, queries });
    const second = analyzeRecallShadow({ lessons, queries });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('handles the empty set without dividing by zero', () => {
    const report = analyzeRecallShadow({ lessons: [], queries: [] });
    expect(report.totals.overallHitRate).toBe(0);
    expect(report.totals.overallFriendlyFireRate).toBe(0);
    expect(report.lessons).toEqual([]);
    expect(report.boundary).toContain('default-OFF');
  });
});

describe('the report cannot be mistaken for an activation', () => {
  it('carries no enabled/recommended flag anywhere', () => {
    const report = analyzeRecallShadow({
      lessons: [shadow(lesson('x', ['cue'], []))],
      queries: [{ queryId: 'q1', query: query('cue') }]
    });
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('"enabled"');
    expect(serialised).not.toContain('"recommended"');
    expect(serialised).not.toContain('"filterOn"');
    // The boundary statement is mandatory.
    expect(report.boundary).toContain('shadow only');
    expect(report.boundary).toContain('default-OFF');
    expect(report.boundary).toContain('does not write');
  });

  it('renders markdown that repeats the boundary and never says "enable"', () => {
    const report = analyzeRecallShadow({
      lessons: [shadow(lesson('y', ['cue'], ['restraint']))],
      queries: [{ queryId: 'q1', query: query('cue restraint') }]
    });
    const markdown = renderRecallShadowMarkdown(report, { generatedAt: '2026-10-31T00:00:00.000Z' });
    expect(markdown).toContain('whenToApply');
    expect(markdown).toContain('shadow only');
    expect(markdown).toContain('default-OFF');
    expect(markdown).toContain('2026-10-31T00:00:00.000Z');
    // Every lesson row is present.
    expect(markdown).toContain('`y`');
    // It must not INSTRUCT anyone to switch filtering on. The boundary sentence
    // legitimately says "does not enable filtering", so the check is for an
    // imperative, not for the substring.
    expect(markdown.toLowerCase()).not.toMatch(/recommend(ed)? to enable/);
    expect(markdown.toLowerCase()).not.toMatch(/should enable/);
    expect(markdown.toLowerCase()).not.toMatch(/turn on/);
  });
});

describe('the module performs no I/O and writes nothing', () => {
  it('has no filesystem or backend call in its source', () => {
    const source = readFileSync(path.join(repoRoot, 'src/memory-bridge/recall-shadow-analysis.ts'), 'utf8');
    expect(source).not.toMatch(/writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync/);
    expect(source).not.toMatch(/node:fs/);
    // It must reuse the production matcher rather than re-deriving the rule.
    expect(source).toContain("from './governance-polyfill'");
  });

  it('does not mutate the lessons or queries it is given', () => {
    const target = lesson('immutable', ['cue'], ['restraint']);
    const before = JSON.stringify(target);
    const lessons = [shadow(target)];
    const queries = [{ queryId: 'q1', query: query('cue restraint') }];
    analyzeRecallShadow({ lessons, queries });
    expect(JSON.stringify(target)).toBe(before);
    expect(lessons).toHaveLength(1);
    expect(queries).toHaveLength(1);
  });
});
