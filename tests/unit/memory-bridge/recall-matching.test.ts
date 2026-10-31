/**
 * P4-2: the positive channel (whenToApply) and the veto channel
 * (whenNotToApply) must be decided by ONE matching rule — the same CJK shingle
 * threshold and the same latin token threshold — and the shadow observation must
 * record the firewall decision without applying it.
 *
 * Discriminative properties asserted here:
 *   - the IDENTICAL clause, moved between the two arrays, matches identically;
 *   - CJK, latin and mixed clauses all go through the shared matcher;
 *   - a restraint hit still vetoes in the live firewall (default unchanged);
 *   - the shadow comparison keeps every recalled lesson and reports the
 *     positive/firewall hit rates next to the live retained/suppressed counts;
 *   - the live firewall configuration and the input records are not mutated.
 */

import { describe, expect, it } from 'vitest';
import {
  applyPostRecallFirewall,
  matchLessonConditions,
  observeRecallInShadow,
  summarizeRecallConditions,
  type DriverLessonRecord
} from '../../../src/memory-bridge';
import type { CanonicalLesson, MemoryRecallQuery } from '../../../src/types/contracts';
import { BRANCH_A_NS, branchScope, memoryConfig, validLesson } from './fixtures';

function query(text: string): MemoryRecallQuery {
  return { scope: branchScope(), text };
}

function record(lesson: CanonicalLesson, namespace: string = BRANCH_A_NS): DriverLessonRecord {
  return { lesson, namespace };
}

describe('shared CJK/latin rule across whenToApply and whenNotToApply', () => {
  it('matches the identical clause identically in both channels', () => {
    const clause = 'offline sandbox unavailable';
    const lesson = validLesson({ id: 'L-shared', whenToApply: [clause], whenNotToApply: [clause] });
    const matches = matchBoth(lesson, 'offline sandbox run');
    expect(matches.whenToApply).toEqual([clause]);
    expect(matches.whenNotToApply).toEqual([clause]);
  });

  it('applies the same latin threshold in both channels', () => {
    const clause = 'offline sandbox unavailable';
    const lesson = validLesson({ id: 'L-latin', whenToApply: [clause], whenNotToApply: [clause] });

    // 2 of 3 significant tokens present -> both channels match.
    expect(channelHitCounts(lesson, 'offline sandbox run')).toEqual([1, 1]);
    // 1 of 3 -> neither channel matches.
    expect(channelHitCounts(lesson, 'offline cache update')).toEqual([0, 0]);
    // unrelated -> neither.
    expect(channelHitCounts(lesson, 'unrelated refactor of the parser')).toEqual([0, 0]);
  });

  it('applies the same CJK rule in both channels', () => {
    const lesson = validLesson({
      id: 'L-cjk',
      whenToApply: ['离线沙箱不可用'],
      whenNotToApply: ['不适用于简单表格任务']
    });

    const both = matchBoth(lesson, '离线沙箱不可用；简单表格任务的场景');
    expect(both.whenToApply).toEqual(['离线沙箱不可用']);
    expect(both.whenNotToApply).toEqual(['不适用于简单表格任务']);

    const restraintOnly = matchBoth(lesson, '简单表格任务');
    expect(restraintOnly.whenToApply).toEqual([]);
    expect(restraintOnly.whenNotToApply).toEqual(['不适用于简单表格任务']);

    const triggerOnly = matchBoth(lesson, '离线沙箱不可用');
    expect(triggerOnly.whenToApply).toEqual(['离线沙箱不可用']);
    expect(triggerOnly.whenNotToApply).toEqual([]);
  });

  it('applies the same mixed CJK+latin rule in both channels', () => {
    const clause = '离线 sandbox 不可用';
    const lesson = validLesson({ id: 'L-mixed', whenToApply: [clause], whenNotToApply: [clause] });

    const hit = matchBoth(lesson, '离线 sandbox 环境');
    expect(hit.whenToApply).toEqual([clause]);
    expect(hit.whenNotToApply).toEqual([clause]);

    const miss = matchBoth(lesson, '在线 sandbox 环境');
    expect(miss.whenToApply).toEqual([]);
    expect(miss.whenNotToApply).toEqual([]);
  });

  it('does not veto on a single incidental CJK bigram (regression: 任务)', () => {
    const lesson = validLesson({
      id: 'L-incidental',
      whenToApply: ['observedSignal=tool_error'],
      whenNotToApply: ['不适用于简单表格任务']
    });
    const matches = matchBoth(lesson, '请帮我完成这个任务');
    expect(matches.whenNotToApply).toEqual([]);
  });

  it('reports every matched cue of the positive channel, not just the first', () => {
    const lesson = validLesson({
      id: 'L-multi',
      whenToApply: ['offline sandbox', 'offline cache'],
      whenNotToApply: ['never on this host']
    });
    const matches = matchBoth(lesson, 'offline sandbox');
    expect(matches.whenToApply).toEqual(['offline sandbox', 'offline cache']);
  });
});

describe('negative firewall veto and record-only shadow observation', () => {
  const vetoedLesson = validLesson({
    id: 'L-veto',
    whenToApply: ['observedSignal=tool_error'],
    whenNotToApply: ['offline sandbox unavailable']
  });

  it('still vetoes in the live firewall (default semantics unchanged)', () => {
    const live = applyPostRecallFirewall({
      records: [record(vetoedLesson)],
      query: query('the offline sandbox is unavailable'),
      scope: branchScope(),
      config: memoryConfig(),
      minConfidence: 0
    });
    expect(live.lessons).toEqual([]);
    expect(live.suppressedLessons.map((entry) => entry.reason)).toEqual(['when_not_to_apply']);
  });

  it('shadow records the same lesson instead of filtering it', () => {
    const shadow = observeRecallInShadow({
      records: [record(vetoedLesson)],
      query: query('the offline sandbox is unavailable'),
      scope: branchScope(),
      config: memoryConfig()
    });

    // Record-only: the lesson is retained even though the live firewall vetoes it.
    expect(shadow.retained.map((lesson) => lesson.id)).toEqual(['L-veto']);
    expect(shadow.retained.length).toBe(shadow.recalled);
    expect(shadow.observations.map((entry) => entry.vetoed)).toEqual([true]);
    expect(shadow.observations[0]?.matchedWhenNotToApply).toEqual(['offline sandbox unavailable']);

    // Comparison against the live firewall is reported, not applied.
    expect(shadow.liveFirewallRetained).toBe(0);
    expect(shadow.liveFirewallSuppressed).toBe(1);
    expect(shadow.restraintHitRate).toBe(1);
    expect(shadow.triggerHitRate).toBe(0);
    expect(shadow.mode).toBe('shadow-record-only');
    expect(shadow.diagnostics.join(' ')).toContain('shadow mode records the firewall decision instead of applying it');
  });

  it('compares the positive hit rate with the firewall hit rate over the same recall set', () => {
    const triggerOnly = validLesson({
      id: 'L-trigger',
      whenToApply: ['offline sandbox unavailable'],
      whenNotToApply: ['do not apply when the build already passes']
    });
    const restraintOnly = validLesson({
      id: 'L-restraint',
      whenToApply: ['a tool keeps failing argument validation'],
      whenNotToApply: ['offline sandbox unavailable']
    });

    const shadow = observeRecallInShadow({
      records: [record(triggerOnly), record(restraintOnly)],
      query: query('offline sandbox unavailable'),
      scope: branchScope(),
      config: memoryConfig()
    });

    expect(shadow.recalled).toBe(2);
    expect(shadow.triggerHits).toBe(1);
    expect(shadow.restraintHits).toBe(1);
    expect(shadow.triggerHitRate).toBe(0.5);
    expect(shadow.restraintHitRate).toBe(0.5);
    expect(shadow.liveFirewallRetained).toBe(1);
    expect(shadow.liveFirewallSuppressed).toBe(1);
    expect(shadow.retained.map((lesson) => lesson.id)).toEqual(['L-trigger', 'L-restraint']);
  });

  it('records (not filters) even when the firewall is disabled by configuration', () => {
    const shadow = observeRecallInShadow({
      records: [record(vetoedLesson)],
      query: query('the offline sandbox is unavailable'),
      scope: branchScope(),
      config: memoryConfig({ enableNegativeFirewall: false })
    });
    expect(shadow.retained.map((lesson) => lesson.id)).toEqual(['L-veto']);
    expect(shadow.liveFirewallRetained).toBe(1);
    expect(shadow.liveFirewallSuppressed).toBe(0);
    expect(shadow.diagnostics.join(' ')).toContain('negative firewall disabled');
    // The default configuration keeps the firewall ON; the shadow path never rewrites it.
    expect(memoryConfig().enableNegativeFirewall).toBe(true);
  });

  it('is pure: no mutation of the recalled records or of the config', () => {
    const records = [record(vetoedLesson)];
    const config = memoryConfig();
    const recordsSnapshot = JSON.parse(JSON.stringify(records)) as unknown;
    const configSnapshot = JSON.parse(JSON.stringify(config)) as unknown;

    observeRecallInShadow({ records, query: query('the offline sandbox is unavailable'), scope: branchScope(), config });
    const second = observeRecallInShadow({
      records,
      query: query('the offline sandbox is unavailable'),
      scope: branchScope(),
      config
    });

    expect(JSON.parse(JSON.stringify(records))).toEqual(recordsSnapshot);
    expect(JSON.parse(JSON.stringify(config))).toEqual(configSnapshot);
    expect(second).toEqual(
      observeRecallInShadow({
        records,
        query: query('the offline sandbox is unavailable'),
        scope: branchScope(),
        config
      })
    );
  });

  it('reports zero rates (not NaN) for an empty recall', () => {
    const summary = summarizeRecallConditions([], query('anything'));
    expect(summary.recalled).toBe(0);
    expect(summary.triggerHitRate).toBe(0);
    expect(summary.restraintHitRate).toBe(0);
    expect(Number.isFinite(summary.triggerHitRate)).toBe(true);
    expect(Number.isFinite(summary.restraintHitRate)).toBe(true);
  });
});

// Helpers kept at the bottom so the assertions above read as data.

function matchBoth(lesson: CanonicalLesson, text: string) {
  return matchLessonConditions(lesson, { scope: branchScope(), text });
}

function channelHitCounts(lesson: CanonicalLesson, text: string): [number, number] {
  const matches = matchLessonConditions(lesson, { scope: branchScope(), text });
  return [matches.whenToApply.length, matches.whenNotToApply.length];
}
