/**
 * rev6 R4 prerequisite: shadow analysis of `whenToApply` recall conditions.
 *
 * WHAT THIS IS
 * ------------
 * A READ-ONLY analyser. Given (a) candidate lessons and (b) the queries a run
 * would have issued, it reports how often each lesson's positive cue
 * (`whenToApply`) would have fired, and how often the negative firewall
 * (`whenNotToApply`) would have vetoed a lesson whose cue fired - i.e. the
 * "friendly fire" rate that decides whether positive filtering may ever be
 * enabled by default.
 *
 * WHAT THIS IS NOT, AND CANNOT BECOME
 * -----------------------------------
 * It writes nothing, calls no backend, and returns no "enable" verdict. `R4`
 * keeps the filter default-off; this module's job is to produce the evidence
 * that could one day justify changing that default, and to make the current
 * state legible in the meantime. There is no `enabled` field anywhere in the
 * output: a caller cannot mistake an analysis for an activation.
 *
 * WHY IT REUSES THE PRODUCTION MATCHER
 * ------------------------------------
 * `matchLessonConditions` is the SAME function the recall path uses. Re-deriving
 * the rule here would let the analysis and the product drift apart, and the
 * report would then describe a filter nobody runs. Every hit/miss below comes
 * from the production matcher, so the numbers cannot be more (or less) accurate
 * than the deployed behaviour.
 */
import type { CanonicalLesson, MemoryRecallQuery } from '../types/contracts';
import { matchLessonConditions } from './governance-polyfill';

/**
 * One lesson under observation.
 *
 * `lesson` is the canonical shape the recall path already handles; `source` is
 * carried for the report so a reader can tell production fixtures from synthetic
 * probes. Nothing here writes the lesson anywhere.
 */
export interface ShadowLesson {
  readonly lesson: CanonicalLesson;
  readonly source: string;
}

/** Per-lesson outcome over the whole query set. */
export interface ShadowLessonSummary {
  readonly lessonId: string;
  readonly title: string;
  readonly source: string;
  /** Queries where a `whenToApply` clause matched (the cue fired). */
  readonly cueHits: number;
  /** Queries where a `whenNotToApply` clause matched (the veto fired). */
  readonly vetoHits: number;
  /**
   * Queries where the cue fired AND the veto fired - the "friendly fire" case.
   * These are the lessons positive filtering would have surfaced and the
   * firewall would then have removed: pure cost, no benefit.
   */
  readonly friendlyFireHits: number;
  /** Queries where the cue fired and no veto applied: the useful hits. */
  readonly usableHits: number;
  /** cueHits / totalQueries (0 when there are no queries). */
  readonly hitRate: number;
  /** vetoHits / cueHits (0 when the cue never fired). */
  readonly vetoRateAmongCues: number;
  /** friendlyFireHits / cueHits (0 when the cue never fired). */
  readonly friendlyFireRate: number;
}

/** One (lesson, query) observation, kept for spot-checking the aggregate. */
export interface ShadowHit {
  readonly lessonId: string;
  readonly queryId: string;
  readonly cueClauses: readonly string[];
  readonly vetoClauses: readonly string[];
  /** `'usable'` when the cue fired without a veto; `'friendly-fire'` when both fired. */
  readonly classification: 'usable' | 'friendly-fire';
}

/** Run-level shadow report. Note the absence of any enable/suggest flag. */
export interface RecallShadowReport {
  readonly totalLessons: number;
  readonly totalQueries: number;
  readonly lessons: readonly ShadowLessonSummary[];
  readonly hits: readonly ShadowHit[];
  readonly totals: {
    /** Queries where at least one lesson's cue fired. */
    readonly queriesWithAnyCue: number;
    readonly cueHits: number;
    readonly vetoHits: number;
    readonly friendlyFireHits: number;
    readonly usableHits: number;
    /** cueHits / (lessons x queries). */
    readonly overallHitRate: number;
    /** friendlyFireHits / cueHits. */
    readonly overallFriendlyFireRate: number;
  };
  /**
   * What this report does and does not decide. Always present, so a reader cannot
   * read the numbers as an activation decision.
   */
  readonly boundary: string;
}

/** Input to the analyser: lessons plus the queries a run would issue. */
export interface RecallShadowInput {
  readonly lessons: readonly ShadowLesson[];
  readonly queries: readonly { readonly queryId: string; readonly query: MemoryRecallQuery }[];
}

const BOUNDARY_TEXT =
  'shadow only: the positive filter stays default-OFF. This report measures hit and friendly-fire rates so a future decision can cite evidence; it does not enable filtering, does not write to any memory backend, and carries no "recommended" flag by design.';

/**
 * Analyse `whenToApply` recall conditions in shadow.
 *
 * Pure: no I/O, no backend, no mutation of the lessons or queries. The same
 * inputs always produce the same report (iteration follows the input order).
 */
export function analyzeRecallShadow(input: RecallShadowInput): RecallShadowReport {
  const perLesson: ShadowLessonSummary[] = [];
  const hits: ShadowHit[] = [];
  const queryIdsWithCue = new Set<string>();
  let totalCueHits = 0;
  let totalVetoHits = 0;
  let totalFriendlyFire = 0;
  let totalUsable = 0;

  for (const entry of input.lessons) {
    let cueHits = 0;
    let vetoHits = 0;
    let friendlyFireHits = 0;
    let usableHits = 0;

    for (const { queryId, query } of input.queries) {
      // The PRODUCTION matcher - not a re-implementation.
      const matches = matchLessonConditions(entry.lesson, query);
      const cueFired = matches.whenToApply.length > 0;
      const vetoFired = matches.whenNotToApply.length > 0;
      if (vetoFired) {
        vetoHits += 1;
      }
      if (!cueFired) {
        continue;
      }
      cueHits += 1;
      queryIdsWithCue.add(queryId);
      if (vetoFired) {
        friendlyFireHits += 1;
        hits.push({
          lessonId: entry.lesson.id,
          queryId,
          cueClauses: matches.whenToApply,
          vetoClauses: matches.whenNotToApply,
          classification: 'friendly-fire'
        });
      } else {
        usableHits += 1;
        hits.push({
          lessonId: entry.lesson.id,
          queryId,
          cueClauses: matches.whenToApply,
          vetoClauses: [],
          classification: 'usable'
        });
      }
    }

    const totalQueries = input.queries.length;
    perLesson.push({
      lessonId: entry.lesson.id,
      title: entry.lesson.title,
      source: entry.source,
      cueHits,
      vetoHits,
      friendlyFireHits,
      usableHits,
      hitRate: totalQueries === 0 ? 0 : cueHits / totalQueries,
      vetoRateAmongCues: cueHits === 0 ? 0 : friendlyFireHits / cueHits,
      friendlyFireRate: cueHits === 0 ? 0 : friendlyFireHits / cueHits
    });
    totalCueHits += cueHits;
    totalVetoHits += vetoHits;
    totalFriendlyFire += friendlyFireHits;
    totalUsable += usableHits;
  }

  const cells = input.lessons.length * input.queries.length;
  return {
    totalLessons: input.lessons.length,
    totalQueries: input.queries.length,
    lessons: perLesson,
    hits,
    totals: {
      queriesWithAnyCue: queryIdsWithCue.size,
      cueHits: totalCueHits,
      vetoHits: totalVetoHits,
      friendlyFireHits: totalFriendlyFire,
      usableHits: totalUsable,
      overallHitRate: cells === 0 ? 0 : totalCueHits / cells,
      overallFriendlyFireRate: totalCueHits === 0 ? 0 : totalFriendlyFire / totalCueHits
    },
    boundary: BOUNDARY_TEXT
  };
}

/**
 * Render the shadow report as markdown.
 *
 * Kept in the module (not in the report script) so the report and the analyser
 * are versioned together, and so the boundary sentence cannot be dropped from a
 * hand-written summary.
 */
export function renderRecallShadowMarkdown(report: RecallShadowReport, options: { readonly generatedAt?: string } = {}): string {
  const lines: string[] = [];
  lines.push('## `whenToApply` shadow 观测（R4 前置）');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| :-- | :-- |');
  if (options.generatedAt !== undefined) {
    lines.push('| 生成时刻 | ' + options.generatedAt + ' |');
  }
  lines.push('| lessons | ' + String(report.totalLessons) + ' |');
  lines.push('| queries | ' + String(report.totalQueries) + ' |');
  lines.push('| 命中率（cue / 全部 lesson×query） | ' + (report.totals.overallHitRate * 100).toFixed(1) + '% |');
  lines.push('| 误伤率（friendly-fire / cue） | ' + (report.totals.overallFriendlyFireRate * 100).toFixed(1) + '% |');
  lines.push('| 有任一 cue 的 query | ' + String(report.totals.queriesWithAnyCue) + ' / ' + String(report.totalQueries) + ' |');
  lines.push('');
  lines.push('| lesson | source | cue 命中 | veto 命中 | 误伤 | 可用 | 命中率 | 误伤率 |');
  lines.push('| :-- | :-- | --: | --: | --: | --: | --: | --: |');
  for (const summary of report.lessons) {
    lines.push(
      '| `' + summary.lessonId + '` | ' + summary.source + ' | ' +
        String(summary.cueHits) + ' | ' + String(summary.vetoHits) + ' | ' +
        String(summary.friendlyFireHits) + ' | ' + String(summary.usableHits) + ' | ' +
        (summary.hitRate * 100).toFixed(1) + '% | ' + (summary.friendlyFireRate * 100).toFixed(1) + '% |'
    );
  }
  lines.push('');
  lines.push('> ' + report.boundary);
  return lines.join('\n');
}
