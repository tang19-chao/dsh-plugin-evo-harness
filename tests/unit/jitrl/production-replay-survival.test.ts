/**
 * P2-B acceptance (p2-a-b-kernel): the replay path reports a PRODUCTION-FILTERED
 * survival denominator and aborts when there is nothing to learn from.
 *
 * The defect this suite guards: the V2 fair/PR-4A engines call the decision
 * kernel without the production learning filter and write records stamped
 * 'r2/verifiable-v1'. Under the production predicate an r2 record is ALWAYS
 * learning_ineligible, so a replay over such a store estimates q from evidence
 * the live path never sees - and reports the resulting zero advantage as a
 * "policy effect".
 *
 * Three layers are asserted, in increasing distance from the unit:
 *   1. the survival counter itself (denominator, per-reason split, readable
 *      sample, main exclusion reason);
 *   2. the PRODUCTION replay hook: it must abort (not degrade to prior weights)
 *      when the production filter leaves no survivor, and it must report the
 *      denominator to its caller on every invocation;
 *   3. the CALL-SITE gate: every production kernel call spreads
 *      learningFacingFilterOptions(), and the two FROZEN eval engines are pinned
 *      as a KNOWN GAP (see the ratchet at the end for its release condition).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AbstractState,
  ExperienceRecord,
  GuidanceMode,
  JitReplayHookInput,
  JitReplayHookResult,
  SelectBatchRequest
} from '../../../src/types/contracts';
import {
  EXPERIENCE_FILTER_REASONS,
  LEARNING_CONSUMER_FILTER,
  LEARNING_FACING_SURVIVAL_ABORT,
  LearningFacingSurvivalError,
  assertLearningFacingSurvival,
  experienceSurvival,
  learningFacingFilterOptions,
  learningFacingSurvival
} from '../../../src/jitrl/decision-kernel';
import {
  CURRENT_PROVENANCE_VERSION,
  CURRENT_REWARD_VERSION,
  EXPERIENCE_SCHEMA_VERSION
} from '../../../src/jitrl/experience-store';
import { createJitReplayHook } from '../../../src/jitrl/index';
import { buildMetaState } from '../../../src/jitrl/jit-active-policy';
import { DEFAULT_EVO_HARNESS_CONFIG } from '../../../src/config';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;

function request(): SelectBatchRequest {
  return {
    task: {
      id: 'task-survival',
      prompt: 'Fix the failing build without breaking the release train.',
      taskSignature: 'fix-build',
      complexity: 'moderate',
      contextTags: ['ci']
    },
    sessionId: 'session-survival',
    tree: {
      id: 'tree-survival',
      sessionId: 'session-survival',
      taskId: 'task-survival',
      rootId: 'root',
      nodes: {
        root: {
          id: 'root',
          treeId: 'tree-survival',
          parentId: null,
          depth: 0,
          branchId: 'branch-root',
          patchId: 'patch-root',
          patchOrigin: 'reference',
          purpose: 'initial',
          guidance: 'guidance_free',
          status: 'succeeded',
          childIds: ['best'],
          createdAt: T0,
          updatedAt: T0
        },
        best: {
          id: 'best',
          treeId: 'tree-survival',
          parentId: 'root',
          depth: 1,
          branchId: 'branch-best',
          patchId: 'patch-best',
          patchOrigin: 'domain',
          purpose: 'deepen',
          guidance: 'memory',
          slot: 'exploit',
          status: 'succeeded',
          childIds: [],
          score: 0.9,
          createdAt: T0,
          updatedAt: T0
        }
      },
      policyId: 'pi-0',
      stats: {
        nodeCount: 2,
        maxDepth: 1,
        maxWidth: 2,
        scoredNodes: 1,
        completedNodes: 2
      },
      completed: false,
      createdAt: T0,
      updatedAt: T0
    },
    grid: {
      maxWidth: 8,
      maxDepth: 2,
      budget: 8,
      skipProbing: false,
      stopCondition: 'budget_exhausted',
      complexity: 'moderate',
      rationale: 'survival grid',
      policyId: 'pi-0'
    },
    memoryConfidence: 0.8,
    round: 1,
    previousBestNodeId: 'best'
  };
}

/** The abstract state every record / replay decision in this file shares. */
function state(): AbstractState {
  return buildMetaState(request());
}

interface RecordOptions {
  readonly id: string;
  readonly value: number;
  readonly legacy?: boolean;
  readonly ineligible?: boolean;
  readonly rewardVersion?: string;
  readonly level?: 'meta' | 'proposal';
  readonly guidance?: GuidanceMode;
  readonly createdAt?: number;
}

/** One L1 meta record matching the canonical state, with a selectable defect. */
function record(options: RecordOptions): ExperienceRecord {
  return {
    id: options.id,
    level: options.level ?? 'meta',
    state: state(),
    actionKey: 'slot:exploit',
    reward: options.value,
    return: options.value,
    rewardSources: { surrogate: options.value },
    guidance: options.guidance ?? 'memory',
    policyId: 'pi-0',
    sessionId: 'session-survival',
    treeId: 'tree-survival',
    nodeId: options.id,
    ...(options.legacy === true
      ? {}
      : {
          experienceSchemaVersion: EXPERIENCE_SCHEMA_VERSION,
          provenanceVersion: CURRENT_PROVENANCE_VERSION,
          rewardVersion: options.rewardVersion ?? CURRENT_REWARD_VERSION
        }),
    ...(options.ineligible === true ? { learningEligible: false } : {}),
    createdAt: options.createdAt ?? T0 - 60_000,
    redacted: true
  };
}

/** A batch with a known per-reason split: 2 kept, 1 legacy, 1 ineligible. */
function mixedHistory(): readonly ExperienceRecord[] {
  return [
    record({ id: 'clean-a', value: 2.5 }),
    record({ id: 'clean-b', value: -2 }),
    record({ id: 'stale-legacy', value: 9, legacy: true }),
    record({ id: 'cancelled', value: 9, ineligible: true })
  ];
}

/** A store written under the RETIRED reward contract (the V2 replay corpus). */
function retiredContractHistory(): readonly ExperienceRecord[] {
  return [
    record({ id: 'r2-a', value: 2.5, rewardVersion: 'r2/verifiable-v1' }),
    record({ id: 'r2-b', value: -2, rewardVersion: 'r2/verifiable-v1' })
  ];
}

function hookInput(experiences: readonly ExperienceRecord[]): JitReplayHookInput {
  return {
    treeId: 'tree-survival',
    policyId: 'pi-0',
    rho: 0.5,
    slotWeights: { exploit: 0.4, explore_domain: 0.3, explore_invariant: 0.2, recover: 0.1 },
    frontier: {
      nodeId: 'best',
      depth: 1,
      patchOrigin: 'domain',
      purpose: 'deepen',
      guidance: 'memory',
      slot: 'exploit',
      score: 0.9,
      createdAt: T0
    },
    experiences,
    jit: { beta: 1, lambda: 0, alpha: 0, k: 10, gamma: 0.5, similarityThreshold: 0.3 },
    driftRho: 0.7
  };
}

function hook(options: {
  readonly requireSurvival?: boolean;
  readonly onSurvival?: (survival: ReturnType<typeof learningFacingSurvival>) => void;
}) {
  return createJitReplayHook({
    config: DEFAULT_EVO_HARNESS_CONFIG.jitrl,
    stateOf: () => state(),
    now: () => NOW,
    seed: 7,
    ...(options.requireSurvival === true ? { requireLearningFacingSurvival: true } : {}),
    ...(options.onSurvival === undefined ? {} : { onLearningSurvival: options.onSurvival })
  });
}

// ---------------------------------------------------------------------------
// 1. The survival counter
// ---------------------------------------------------------------------------

describe('production-filtered survival counting', () => {
  it('reports the denominator, every reason, the main exclusion and a readable sample', () => {
    const survival = learningFacingSurvival(mixedHistory(), { level: 'meta', guidance: 'memory' });
    expect(survival.records).toBe(4);
    expect(survival.survivors).toBe(2);
    expect(survival.excluded).toBe(2);
    expect(survival.byReason.kept).toBe(2);
    expect(survival.byReason.legacy).toBe(1);
    expect(survival.byReason.learning_ineligible).toBe(1);
    expect(survival.excludeLegacy).toBe(true);
    expect(survival.learningEligibleOnly).toBe(true);
    // 1:1 between the two exclusions, so one is NAMED; the point is that the
    // reason is reported, not that a tie is broken in a specific way.
    expect(['legacy', 'learning_ineligible']).toContain(survival.mainExclusion);
    expect(survival.sample.length).toBe(2);
    expect(survival.sample.join(' ')).toContain('stale-legacy:legacy');
    expect(survival.sample.join(' ')).toContain('cancelled:learning_ineligible');
    // Exactly the filter's reason vocabulary: a new reason added to the kernel
    // must show up here (a missing key would silently under-report).
    expect(Object.keys(survival.byReason).sort()).toEqual([...EXPERIENCE_FILTER_REASONS].sort());
  });

  it('names the other filter stages too (level, guidance, causal cutoff)', () => {
    const cutoff = T0 - 120_000;
    const survival = experienceSurvival(
      [
        record({ id: 'wrong-level', value: 1, level: 'proposal' }),
        record({ id: 'wrong-guidance', value: 1, guidance: 'guidance_free' }),
        record({ id: 'after-cutoff', value: 1, createdAt: T0 })
      ],
      { level: 'meta', guidance: 'memory', before: cutoff }
    );
    expect(survival.survivors).toBe(0);
    expect(survival.byReason.level).toBe(1);
    expect(survival.byReason.guidance).toBe(1);
    expect(survival.byReason.time).toBe(1);
  });

  it('uses the exact production filter object (no second copy of the flags)', () => {
    const survival = learningFacingSurvival(mixedHistory(), { level: 'meta', guidance: 'memory' });
    const strict = learningFacingFilterOptions();
    expect(survival.excludeLegacy).toBe(strict.excludeLegacy);
    expect(survival.learningEligibleOnly).toBe(strict.learningEligibleOnly);
    expect(strict).toEqual(LEARNING_CONSUMER_FILTER);
  });

  it('aborts on an all-learning_ineligible snapshot and never on a cold start', () => {
    const allRetired = learningFacingSurvival(retiredContractHistory(), {
      level: 'meta',
      guidance: 'memory'
    });
    expect(allRetired.records).toBe(2);
    expect(allRetired.survivors).toBe(0);
    expect(allRetired.mainExclusion).toBe('learning_ineligible');

    let thrown: unknown;
    try {
      assertLearningFacingSurvival(allRetired, { context: 'unit-test' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LearningFacingSurvivalError);
    const failure = thrown as LearningFacingSurvivalError;
    expect(failure.code).toBe(LEARNING_FACING_SURVIVAL_ABORT);
    // The message must carry the denominator, the main reason, the per-reason
    // split, the remediation contract id and a readable excluded sample.
    expect(failure.message).toContain('0 of 2 records survive the production filter');
    expect(failure.message).toContain('main exclusion reason: learning_ineligible');
    expect(failure.message).toContain('learning_ineligible=2');
    expect(failure.message).toContain('rewardVersion=' + CURRENT_REWARD_VERSION);
    expect(failure.message).toContain('r2-a:learning_ineligible');
    expect(failure.survival.records).toBe(2);

    // An EMPTY snapshot is a legitimate cold start: nothing to filter, no abort.
    expect(() =>
      assertLearningFacingSurvival(learningFacingSurvival([], { level: 'meta' }), { context: 'cold' })
    ).not.toThrow();
    // One survivor is enough to continue; the threshold is a count, not a share.
    expect(() =>
      assertLearningFacingSurvival(
        learningFacingSurvival([record({ id: 'one', value: 1 })], { level: 'meta', guidance: 'memory' }),
        { context: 'one' }
      )
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. The production replay hook
// ---------------------------------------------------------------------------

describe('replay hook: survival denominator and explicit abort', () => {
  it('aborts instead of degrading when every record is on the retired contract', () => {
    const strictHook = hook({ requireSurvival: true });
    let thrown: unknown;
    try {
      strictHook(hookInput(retiredContractHistory()));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LearningFacingSurvivalError);
    // The abort escapes the hook's degrade-to-prior catch: a caller must never
    // receive a prior-shaped result for an all-filtered neighbourhood.
    expect((thrown as LearningFacingSurvivalError).context).toBe('jit-replay-hook');
  });

  it('keeps the documented never-throws contract when the assertion is not requested', () => {
    const lenient = hook({});
    const replayed: JitReplayHookResult = lenient(hookInput(retiredContractHistory()));
    // Nothing survived, so the correction IS the prior - but the hook does not
    // throw for a caller that never asked for the assertion (documented
    // contract), and a zero KL says "no evidence", not "no effect".
    // Renormalization means the prior comes back with float noise, not exactly
    // the input shares: compare numerically.
    expect(replayed.slotWeights.exploit).toBeCloseTo(0.4, 12);
    expect(replayed.slotWeights.explore_domain).toBeCloseTo(0.3, 12);
    expect(replayed.slotWeights.explore_invariant).toBeCloseTo(0.2, 12);
    expect(replayed.slotWeights.recover).toBeCloseTo(0.1, 12);
    expect(replayed.diagnostics.klToPrior).toBe(0);
  });

  it('proceeds and reports the survival counts when production-eligible evidence exists', () => {
    const seen: ReturnType<typeof learningFacingSurvival>[] = [];
    const strictHook = hook({
      requireSurvival: true,
      onSurvival: (survival) => seen.push(survival)
    });
    const replayed = strictHook(hookInput(mixedHistory()));
    expect(seen.length).toBe(1);
    expect(seen[0]?.records).toBe(4);
    expect(seen[0]?.survivors).toBe(2);
    expect(replayed.diagnostics.neighborCount).toBe(2);
    // The strict evidence (2.5 and -2) sets V; a filtered poisoned record would
    // have moved it to a value near 9.
    expect(replayed.diagnostics.stateValue).toBeCloseTo(0.25, 6);
  });
});

// ---------------------------------------------------------------------------
// 3. Call-site gates (read-only, structural)
// ---------------------------------------------------------------------------

/** Every .ts file under src/ (recursive, sorted, absolute paths). */
function sourceFiles(): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        found.push(absolute);
      }
    }
  };
  walk(join(REPO_ROOT, 'src'));
  return found.sort();
}

/**
 * Blank out comments and string/template literals, preserving LENGTH and
 * NEWLINES so line numbers still point at the original file.
 *
 * A scanner that searches raw source finds runDecisionKernel inside JSDoc (the
 * kernel's own header mentions the name), which would report a phantom call site
 * and make the gate useless. Blanking (rather than deleting) keeps every offset
 * valid.
 */
function stripNonCode(source: string): string {
  const chars = source.split('');
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    const next = chars[index + 1];
    if (char === '/' && next === '/') {
      while (index < chars.length && chars[index] !== '\n') {
        chars[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 2;
      while (index < chars.length && !(chars[index] === '*' && chars[index + 1] === '/')) {
        if (chars[index] !== '\n') chars[index] = ' ';
        index += 1;
      }
      if (index < chars.length) {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 2;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === String.fromCharCode(96)) {
      const quote = char;
      chars[index] = ' ';
      index += 1;
      while (index < chars.length) {
        if (chars[index] === '\\') {
          if (chars[index] !== '\n') chars[index] = ' ';
          if (chars[index + 1] !== '\n') chars[index + 1] = ' ';
          index += 2;
          continue;
        }
        if (chars[index] === quote) {
          chars[index] = ' ';
          index += 1;
          break;
        }
        if (chars[index] !== '\n') chars[index] = ' ';
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return chars.join('');
}

/**
 * Extract every CALL of runDecisionKernel(...) from TypeScript source.
 *
 * Operates on the comment/string-stripped text (see stripNonCode), skips the
 * function DEFINITION, follows the optional generic argument list and balances
 * parentheses.
 */
function kernelCallSites(
  source: string
): readonly { readonly line: number; readonly argument: string }[] {
  const sites: { line: number; argument: string }[] = [];
  const needle = 'runDecisionKernel';
  const backtick = String.fromCharCode(96);
  source = stripNonCode(source);
  let index = 0;
  while ((index = source.indexOf(needle, index)) >= 0) {
    const before = source.slice(Math.max(0, index - 40), index);
    index += needle.length;
    if (/function\s+$/.test(before) || /typeof\s+$/.test(before)) continue;
    let cursor = index;
    while (cursor < source.length && /\s/.test(source[cursor] as string)) cursor += 1;
    if (source[cursor] === '<') {
      let depth = 0;
      while (cursor < source.length) {
        const char = source[cursor];
        if (char === '<') depth += 1;
        else if (char === '>') {
          depth -= 1;
          if (depth === 0) {
            cursor += 1;
            break;
          }
        }
        cursor += 1;
      }
      while (cursor < source.length && /\s/.test(source[cursor] as string)) cursor += 1;
    }
    if (source[cursor] !== '(') continue;
    const start = cursor;
    let depth = 0;
    let quote: string | null = null;
    while (cursor < source.length) {
      const char = source[cursor] as string;
      if (quote !== null) {
        if (char === '\\') cursor += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === backtick) {
        quote = char;
      } else if (char === '/' && source[cursor + 1] === '/') {
        while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
        continue;
      } else if (char === '/' && source[cursor + 1] === '*') {
        cursor += 2;
        while (cursor < source.length && !(source[cursor] === '*' && source[cursor + 1] === '/')) {
          cursor += 1;
        }
        cursor += 1;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      cursor += 1;
    }
    const line = source.slice(0, start).split('\n').length;
    sites.push({ line, argument: source.slice(start, cursor + 1) });
  }
  return sites;
}

describe('production call sites spread the learning-facing filter', () => {
  it('every runDecisionKernel call under src/ carries learningFacingFilterOptions()', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      const where = relative(REPO_ROOT, file).split(sep).join('/');
      for (const site of kernelCallSites(source)) {
        checked += 1;
        if (!site.argument.includes('learningFacingFilterOptions')) {
          offenders.push(where + ':' + String(site.line));
        }
      }
    }
    // Two production call sites exist today (L1 decorator + Dream replay hook).
    expect(checked).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});

/**
 * KNOWN GAP RATCHET (P2-B), NOT a claim that the problem is fixed.
 *
 * The two frozen eval engines still call the kernel without the production
 * filter and still stamp 'r2/verifiable-v1'. They are deliberately NOT edited in
 * P2-B: changing their defaults would move the historical -0.250 fair-eval frame
 * asserted by negative-result-diag.mjs --assert and the e2e klMean parity, i.e.
 * it would rewrite a historical negative result (a permanent prohibition). The
 * aligned path is the NEW V3 replay (scripts/eval/pr4a-v3-replay.mjs), which the
 * probe's own assertions cover.
 *
 * RELEASE CONDITION - this ratchet must be updated in the SAME change that:
 *   (a) re-runs the five-arm experiment under a NEW pre-registration (P2-C
 *       records a new digest; the historical report stays untouched), or
 *   (b) is explicitly authorised as "the historical frame may move" by the
 *       captain.
 * Until then this test is GREEN on purpose and FAILS loudly the moment the gap is
 * closed without the rerun, which is what keeps it from becoming a permanent
 * excuse.
 */
describe('known gap: the frozen V2 eval engines remain unaligned (documented)', () => {
  it('pins the two frozen engines: unfiltered kernel calls and r2-stamped write-back', () => {
    const expectations = [
      {
        file: 'scripts/eval/jitrl-eval-lib.ts',
        unfilteredCallSites: 2,
        stamps: ["const FAIR_R2_SCALE_VERSION = 'r2/verifiable-v1'"]
      },
      {
        file: 'scripts/eval/pr4a-five-arm-lib.ts',
        unfilteredCallSites: 1,
        stamps: ["rewardVersion: 'r2/verifiable-v1'", 'oracleCoverage: 1']
      }
    ] as const;

    for (const expectation of expectations) {
      const source = readFileSync(join(REPO_ROOT, expectation.file), 'utf8');
      const sites = kernelCallSites(source);
      expect(sites.length).toBe(expectation.unfilteredCallSites);
      for (const site of sites) {
        // Pinned as UNFILTERED: if one of these starts spreading the filter, the
        // historical frame has moved and the release condition above applies.
        expect(site.argument.includes('learningFacingFilterOptions')).toBe(false);
      }
      for (const stamp of expectation.stamps) {
        expect(source.includes(stamp)).toBe(true);
      }
    }
  });
});
