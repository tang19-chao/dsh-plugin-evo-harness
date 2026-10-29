/**
 * Harness² anonymous behavioral composer.
 *
 * ARCHITECTURE.md §7.4: the composer collects the reference and candidate
 * event-sourced trajectories, anonymizes the deliverables, contrasts behavior
 * and merges the evidence-supported component edits into the final scaffold H*.
 *
 * Guarantees:
 * 1. The judge (injected IModelAdapter, purpose 'compose') only ever sees an
 *    AnonymizedCandidate dossier: alias, deliverable, metrics, step summary and
 *    the behavioral contrast table. Branch/node/patch identities are removed
 *    and every known identifier is redacted from free text.
 * 2. The judge's ranking can only blend a bounded share (default 15%) into the
 *    adoption ratio; the deterministic evidence score carries the rest.
 * 3. A candidate whose trajectory did not succeed can never be selected; when
 *    nothing succeeded the result reports selectedPatch/composedPatch null.
 * 4. Every adoption ratio is clamped to [0, 1].
 */

import {
  type AnonymizedCandidate,
  type BehavioralContrast,
  type CandidateAssessment,
  type ComposeRequest,
  type CompositionResult,
  type ContrastDimension,
  type EightSurfaceEdits,
  type EightSurfacePatch,
  type IHarnessComposer,
  type IModelAdapter,
  type ModelMessage,
  type ModelRequest,
  type ProbeCandidate,
  type ProbeTrajectory,
  type TrajectoryStatus
} from '../types/contracts';
// P3-B: every model call leaves this module through the unified metered boundary.
import { createMeteredModelAdapter, type MeteredModelOptions } from '../dsh-bridge/metered-model-adapter';
import {
  type Clock,
  type IdFactory,
  clamp01,
  createDeterministicIdFactory,
  deliverableOf,
  extractJsonValue,
  isRecord,
  nonEmptyString,
  oneLine,
  readStringList,
  redactIdentifiers,
  stripStructuredAdvice,
  summarizeTrajectorySteps,
  systemClock,
  truncate
} from './shared';

/** Contract order of the behavioral contrast dimensions. */
export const CONTRAST_DIMENSIONS: readonly ContrastDimension[] = [
  'task_completion',
  'steps',
  'tool_errors',
  'deliverable_quality',
  'cost',
  'robustness'
];

/** Fixed evidence weights; they sum to 1. */
export const DEFAULT_CONTRAST_WEIGHTS: Readonly<Record<ContrastDimension, number>> = {
  task_completion: 0.35,
  steps: 0.2,
  tool_errors: 0.2,
  deliverable_quality: 0.15,
  cost: 0.05,
  robustness: 0.05
};

/** How much of the adoption ratio comes from evidence vs from the judge. */
export const DEFAULT_ADOPTION_BLEND = { evidence: 0.85, judge: 0.15 } as const;

/** Injectable dependencies of the anonymous composer. */
export interface HarnessComposerOptions {
  /** Host-neutral LLM boundary used as the anonymous judge. */
  readonly model: IModelAdapter;
  /** P3-B metering wiring (ledger/registry); absent records calls without cost. */
  readonly metering?: MeteredModelOptions;
  /** Injected clock; defaults to Date.now(). */
  readonly now?: Clock;
  /** Injected id factory; defaults to a deterministic counter. */
  readonly newId?: IdFactory;
  /** Evidence share of the adoption ratio; defaults to 0.85. */
  readonly evidenceWeight?: number;
  /** Judge share of the adoption ratio; defaults to 0.15. */
  readonly judgeWeight?: number;
  /** Judge temperature; defaults to 0. */
  readonly temperature?: number;
  /** Judge response token cap; defaults to 1536. */
  readonly maxTokens?: number;
  /** Deliverable characters shown per dossier; defaults to 1200. */
  readonly deliverableChars?: number;
}

interface DimensionAssessment {
  readonly dimension: ContrastDimension;
  readonly score: number;
  readonly contrast: BehavioralContrast;
}

interface EvidenceAssessment {
  readonly score: number;
  readonly contrasts: readonly BehavioralContrast[];
}

function statusScore(status: TrajectoryStatus): number {
  switch (status) {
    case 'succeeded':
      return 1;
    case 'timeout':
      return 0.25;
    case 'failed':
    case 'aborted':
    default:
      return 0;
  }
}

function completionDimension(reference: ProbeTrajectory | undefined, candidate: ProbeTrajectory): DimensionAssessment {
  const referenceStatus = reference?.status;
  const score = statusScore(candidate.status);
  const evidence: string[] = ['candidate status=' + candidate.status];
  if (referenceStatus === undefined) {
    evidence.push('no reference run; absolute completion score');
  } else {
    evidence.push('reference status=' + referenceStatus);
  }
  const contrast: BehavioralContrast = {
    dimension: 'task_completion',
    referenceValue: referenceStatus ?? null,
    candidateValue: candidate.status,
    delta: referenceStatus === undefined ? undefined : score - statusScore(referenceStatus),
    evidence
  };
  return { dimension: 'task_completion', score, contrast };
}

function stepsDimension(reference: ProbeTrajectory | undefined, candidate: ProbeTrajectory): DimensionAssessment {
  const candidateSteps = candidate.metrics.steps;
  const referenceSteps = reference?.metrics.steps;
  let score: number;
  const evidence: string[] = ['candidate steps=' + candidateSteps];
  if (referenceSteps === undefined) {
    score = clamp01(8 / (8 + candidateSteps));
    evidence.push('absolute efficiency score 8/(8+steps)');
  } else {
    score = clamp01(0.5 + (referenceSteps - candidateSteps) / (2 * Math.max(referenceSteps, 1)));
    evidence.push('reference steps=' + referenceSteps);
  }
  const contrast: BehavioralContrast = {
    dimension: 'steps',
    referenceValue: referenceSteps ?? null,
    candidateValue: candidateSteps,
    delta: referenceSteps === undefined ? undefined : candidateSteps - referenceSteps,
    evidence
  };
  return { dimension: 'steps', score, contrast };
}

function toolErrorsDimension(reference: ProbeTrajectory | undefined, candidate: ProbeTrajectory): DimensionAssessment {
  const candidateErrors = candidate.metrics.toolErrors;
  const referenceErrors = reference?.metrics.toolErrors;
  let score: number;
  const evidence: string[] = ['candidate toolErrors=' + candidateErrors];
  if (referenceErrors === undefined) {
    score = clamp01(1 / (1 + candidateErrors));
    evidence.push('absolute score 1/(1+toolErrors)');
  } else {
    score = candidateErrors <= referenceErrors ? 1 : clamp01(referenceErrors / Math.max(candidateErrors, 1));
    evidence.push('reference toolErrors=' + referenceErrors);
  }
  const contrast: BehavioralContrast = {
    dimension: 'tool_errors',
    referenceValue: referenceErrors ?? null,
    candidateValue: candidateErrors,
    delta: referenceErrors === undefined ? undefined : candidateErrors - referenceErrors,
    evidence
  };
  return { dimension: 'tool_errors', score, contrast };
}

function deliverableDimension(reference: ProbeTrajectory | undefined, candidate: ProbeTrajectory): DimensionAssessment {
  const deliverable = deliverableOf(candidate);
  const produced = candidate.deliverable !== undefined;
  const chars = produced ? deliverable.content.length : 0;
  const referenceDeliverable = reference === undefined ? undefined : deliverableOf(reference);
  const referenceChars = referenceDeliverable === undefined ? 0 : referenceDeliverable.content.length;
  const base = produced ? 0.5 : 0;
  const ratio = referenceChars > 0 ? clamp01(chars / (2 * referenceChars)) : clamp01(chars / 1000);
  const score = clamp01(base + 0.5 * ratio);
  const evidence: string[] = [
    produced
      ? 'candidate deliverable chars=' + chars + ' hash=' + String(deliverable.contentHash)
      : 'candidate produced no deliverable'
  ];
  evidence.push(referenceChars > 0 ? 'reference deliverable chars=' + referenceChars : 'no reference deliverable');
  const contrast: BehavioralContrast = {
    dimension: 'deliverable_quality',
    referenceValue: referenceChars > 0 ? referenceChars : null,
    candidateValue: produced ? chars : null,
    delta: referenceChars > 0 && produced ? chars - referenceChars : undefined,
    evidence
  };
  return { dimension: 'deliverable_quality', score, contrast };
}

function costDimension(reference: ProbeTrajectory | undefined, candidate: ProbeTrajectory): DimensionAssessment {
  const candidateTokens = candidate.metrics.totalTokens;
  const referenceTokens = reference?.metrics.totalTokens;
  const useTokens = candidateTokens !== undefined && (reference === undefined || referenceTokens !== undefined);
  let score: number;
  const evidence: string[] = [];
  let referenceValue: number | null = null;
  let candidateValue: number;
  let delta: number | undefined;
  if (useTokens && candidateTokens !== undefined) {
    candidateValue = candidateTokens;
    if (referenceTokens === undefined) {
      score = clamp01(4000 / (4000 + candidateTokens));
      evidence.push('absolute token cost 4000/(4000+tokens)');
    } else {
      referenceValue = referenceTokens;
      score = clamp01(1 - (candidateTokens - referenceTokens) / Math.max(referenceTokens, 1));
      delta = candidateTokens - referenceTokens;
      evidence.push('reference totalTokens=' + referenceTokens);
    }
    evidence.push('candidate totalTokens=' + candidateTokens);
  } else {
    const candidateMs = candidate.metrics.durationMs;
    const referenceMs = reference?.metrics.durationMs;
    candidateValue = candidateMs;
    if (referenceMs === undefined) {
      score = clamp01(30000 / (30000 + candidateMs));
      evidence.push('absolute duration cost 30000/(30000+ms)');
    } else {
      referenceValue = referenceMs;
      score = clamp01(1 - (candidateMs - referenceMs) / Math.max(referenceMs, 1));
      delta = candidateMs - referenceMs;
      evidence.push('reference durationMs=' + referenceMs);
    }
    evidence.push('candidate durationMs=' + candidateMs);
  }
  const contrast: BehavioralContrast = {
    dimension: 'cost',
    referenceValue,
    candidateValue,
    delta,
    evidence
  };
  return { dimension: 'cost', score, contrast };
}

function robustnessDimension(reference: ProbeTrajectory | undefined, candidate: ProbeTrajectory): DimensionAssessment {
  const signals = candidate.failureSignals.length;
  const referenceSignals = reference?.failureSignals.length;
  let score: number;
  const evidence: string[] = ['candidate failure signals=' + signals];
  if (referenceSignals === undefined) {
    score = clamp01(1 / (1 + signals + candidate.toolErrors.length / 2));
    evidence.push('absolute robustness score');
  } else {
    score = clamp01(1 - (signals - referenceSignals) / Math.max(1, referenceSignals + 1));
    evidence.push('reference failure signals=' + referenceSignals);
  }
  if (signals > 0) {
    evidence.push('signal kinds: ' + candidate.failureSignals.map((signal) => signal.kind).join(', '));
  }
  const contrast: BehavioralContrast = {
    dimension: 'robustness',
    referenceValue: referenceSignals ?? null,
    candidateValue: signals,
    delta: referenceSignals === undefined ? undefined : signals - referenceSignals,
    evidence
  };
  return { dimension: 'robustness', score, contrast };
}

function dimensionAssessments(
  reference: ProbeTrajectory | undefined,
  candidate: ProbeTrajectory
): readonly DimensionAssessment[] {
  return [
    completionDimension(reference, candidate),
    stepsDimension(reference, candidate),
    toolErrorsDimension(reference, candidate),
    deliverableDimension(reference, candidate),
    costDimension(reference, candidate),
    robustnessDimension(reference, candidate)
  ];
}

/** Deterministic behavioral contrast of one candidate against the reference. */
export function computeBehavioralContrasts(
  reference: ProbeTrajectory | undefined,
  candidate: ProbeTrajectory
): readonly BehavioralContrast[] {
  return dimensionAssessments(reference, candidate).map((assessment) => assessment.contrast);
}

/** Deterministic evidence score in [0, 1] for one candidate. */
export function scoreCandidateEvidence(
  reference: ProbeTrajectory | undefined,
  candidate: ProbeTrajectory
): number {
  return assessCandidate(reference, candidate).score;
}

function assessCandidate(reference: ProbeTrajectory | undefined, candidate: ProbeTrajectory): EvidenceAssessment {
  const assessments = dimensionAssessments(reference, candidate);
  let weighted = 0;
  let weightSum = 0;
  for (const assessment of assessments) {
    const weight = DEFAULT_CONTRAST_WEIGHTS[assessment.dimension];
    weighted += weight * assessment.score;
    weightSum += weight;
  }
  return {
    score: clamp01(weightSum > 0 ? weighted / weightSum : 0),
    contrasts: assessments.map((assessment) => assessment.contrast)
  };
}

function aliasFor(index: number): string {
  if (index < 26) {
    return 'candidate_' + String.fromCharCode(65 + index);
  }
  return 'candidate_' + String(index + 1);
}

interface CandidateEvaluation {
  readonly candidate: ProbeCandidate;
  readonly alias: string;
  readonly anonymized: AnonymizedCandidate;
  readonly contrasts: readonly BehavioralContrast[];
  readonly evidenceScore: number;
  adoptionRatio: number;
  judgeRank: number | undefined;
  judgeRationale: string | undefined;
  judgeRejectedReason: string | undefined;
}

interface JudgeVerdict {
  readonly ranking: readonly string[];
  readonly rationales: Readonly<Record<string, string>>;
  readonly rejectedReasons: Readonly<Record<string, string>>;
}

function identifiersOf(request: ComposeRequest, reference: ProbeTrajectory | undefined): string[] {
  const identifiers: string[] = [];
  const push = (value: string | undefined): void => {
    if (value !== undefined && value.length > 0 && !identifiers.includes(value)) {
      identifiers.push(value);
    }
  };
  for (const candidate of request.candidates) {
    push(candidate.branchId);
    push(candidate.nodeId);
    push(candidate.patch.id);
    push(candidate.trajectory.branchId);
    push(candidate.trajectory.id);
    push(candidate.trajectory.branchNamespace);
    push(candidate.trajectory.patchId);
  }
  if (reference !== undefined) {
    push(reference.branchId);
    push(reference.id);
    push(reference.branchNamespace);
    push(reference.patchId);
    push(reference.nodeId);
  }
  return identifiers;
}

function anonymizeCandidate(
  candidate: ProbeCandidate,
  alias: string,
  identifiers: readonly string[],
  deliverableChars: number
): AnonymizedCandidate {
  const deliverable = deliverableOf(candidate.trajectory);
  // Strip structured advice fragments from deliverable content as well (L2 governance)
  const cleanedContent = stripStructuredAdvice(deliverable.content);
  const redacted = redactIdentifiers(cleanedContent, identifiers);
  return {
    alias,
    deliverable: {
      content: truncate(redacted, deliverableChars),
      format: deliverable.format,
      contentHash: deliverable.contentHash,
      producedFiles: deliverable.producedFiles
    },
    metrics: candidate.trajectory.metrics,
    stepsSummary: summarizeTrajectorySteps(candidate.trajectory.steps).map((line) =>
      redactIdentifiers(line, identifiers)
    )
  };
}

function buildJudgeMessages(
  request: ComposeRequest,
  evaluations: readonly CandidateEvaluation[],
  reference: ProbeTrajectory | undefined
): readonly ModelMessage[] {
  const system: string[] = [];
  system.push('You are the Harness² anonymous behavioral judge for a DeepSeek Harness (Cordis) agent.');
  system.push(
    'Candidate identities are removed. Judge ONLY the observed behavior: task completion first, then fewer steps, fewer tool errors, better deliverable, lower cost, higher robustness.'
  );
  system.push('Never guess which scaffold edit produced a candidate and never reward verbosity.');
  system.push('Return exactly ONE JSON object, no prose:');
  system.push(
    '{ "ranking": ["candidate_A", ...best first], "assessments": [{ "alias": "candidate_A", "rationale": string, "rejectedReason": string }] }'
  );
  system.push('Rank every alias you were given exactly once; omit rejectedReason for the top choice.');

  const identifiers = identifiersOf(request, reference);
  const user: string[] = [];
  user.push('## Task');
  user.push('prompt: ' + truncate(oneLine(request.task.prompt), 900));
  if (request.task.taskSignature !== undefined) {
    user.push('taskSignature: ' + request.task.taskSignature);
  }
  user.push('');
  user.push('## Anonymous candidates (' + evaluations.length + ')');
  for (const evaluation of evaluations) {
    const dossier = evaluation.anonymized;
    user.push('');
    user.push('### ' + dossier.alias);
    user.push(
      'metrics: steps=' +
        dossier.metrics.steps +
        ' toolCalls=' +
        dossier.metrics.toolCalls +
        ' toolErrors=' +
        dossier.metrics.toolErrors +
        ' durationMs=' +
        dossier.metrics.durationMs
    );
    if (dossier.stepsSummary.length > 0) {
      user.push('steps:');
      for (const line of dossier.stepsSummary) {
        user.push('  ' + line);
      }
    }
    if (dossier.deliverable.producedFiles !== undefined && dossier.deliverable.producedFiles.length > 0) {
      user.push('producedFiles: ' + redactIdentifiers(dossier.deliverable.producedFiles.join(', '), identifiers));
    }
    user.push('deliverable:');
    user.push(dossier.deliverable.content);
  }
  user.push('');
  user.push('## Behavioral contrast vs reference');
  if (reference === undefined) {
    user.push('no reference trajectory was provided; contrasts show absolute measurements.');
  }
  for (const evaluation of evaluations) {
    user.push('### ' + evaluation.alias);
    for (const contrast of evaluation.contrasts) {
      user.push(
        '- ' +
          contrast.dimension +
          ': reference=' +
          String(contrast.referenceValue) +
          ' candidate=' +
          String(contrast.candidateValue) +
          (contrast.delta === undefined ? '' : ' delta=' + contrast.delta) +
          ' | ' +
          contrast.evidence.join('; ')
      );
    }
  }
  user.push('');
  user.push('## Output');
  user.push('Return the single JSON verdict object now.');

  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: user.join('\n') }
  ];
}

function readJudgeVerdict(text: string, aliases: readonly string[]): JudgeVerdict | undefined {
  const parsed = readJsonRecord(text);
  if (parsed === undefined) {
    return undefined;
  }
  const ranking = readStringList(parsed.ranking, 64) ?? [];
  const known = new Set(aliases);
  const ranked: string[] = [];
  for (const alias of ranking) {
    if (known.has(alias) && !ranked.includes(alias)) {
      ranked.push(alias);
    }
  }
  const rationales: Record<string, string> = {};
  const rejectedReasons: Record<string, string> = {};
  if (Array.isArray(parsed.assessments)) {
    for (const item of parsed.assessments) {
      if (!isRecord(item)) {
        continue;
      }
      const alias = nonEmptyString(item.alias);
      if (alias === undefined || !known.has(alias)) {
        continue;
      }
      const rationale = nonEmptyString(item.rationale);
      if (rationale !== undefined) {
        rationales[alias] = rationale;
      }
      const rejected = nonEmptyString(item.rejectedReason);
      if (rejected !== undefined) {
        rejectedReasons[alias] = rejected;
      }
    }
  }
  return { ranking: ranked, rationales, rejectedReasons };
}

function readJsonRecord(text: string): Record<string, unknown> | undefined {
  const parsed = extractJsonValue(text);
  return isRecord(parsed) ? parsed : undefined;
}

function judgeScoreOf(rank: number | undefined, total: number): number | undefined {
  if (rank === undefined) {
    return undefined;
  }
  if (total <= 1) {
    return 1;
  }
  return clamp01(1 - (rank - 1) / (total - 1));
}

function isBetter(left: CandidateEvaluation, right: CandidateEvaluation): boolean {
  if (left.adoptionRatio !== right.adoptionRatio) {
    return left.adoptionRatio > right.adoptionRatio;
  }
  if (left.evidenceScore !== right.evidenceScore) {
    return left.evidenceScore > right.evidenceScore;
  }
  return left.alias < right.alias;
}

function mergeEdits(base: EightSurfaceEdits | undefined, overlay: EightSurfaceEdits): EightSurfaceEdits {
  const merged: Record<string, unknown> = {};
  if (base !== undefined) {
    Object.assign(merged, base);
  }
  Object.assign(merged, overlay);
  return merged as EightSurfaceEdits;
}

/**
 * Build the anonymous behavioral composer. The returned object implements the
 * frozen IHarnessComposer contract and performs no I/O beyond the injected
 * judge model adapter.
 */
export function createAnonymousComposer(options: HarnessComposerOptions): IHarnessComposer {
  const now = options.now ?? systemClock;
  const newId = options.newId ?? createDeterministicIdFactory('compose');
  const evidenceWeight = options.evidenceWeight ?? DEFAULT_ADOPTION_BLEND.evidence;
  const judgeWeight = options.judgeWeight ?? DEFAULT_ADOPTION_BLEND.judge;
  const deliverableChars = options.deliverableChars ?? 1200;
  const model = createMeteredModelAdapter(options.model, 'compose', options.metering);

  return {
    async compose(request: ComposeRequest): Promise<CompositionResult> {
      const evaluatedAt = now();
      const candidates = [...request.candidates];
      if (candidates.length === 0) {
        return {
          selectedBranchId: null,
          selectedNodeId: null,
          selectedTrajectoryId: null,
          selectedPatch: null,
          composedPatch: null,
          assessments: [],
          adoptionRatios: {},
          rationale: 'no candidates were supplied; nothing to compose',
          evaluatedAt
        };
      }

      const ordered = [...candidates].sort((left, right) => {
        const leftKey = left.branchId + '\u0000' + left.nodeId;
        const rightKey = right.branchId + '\u0000' + right.nodeId;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });

      const reference =
        request.reference ?? ordered.find((candidate) => candidate.trajectory.role === 'reference')?.trajectory;
      const identifiers = identifiersOf(request, reference);

      const evaluations: CandidateEvaluation[] = ordered.map((candidate, index) => {
        const alias = aliasFor(index);
        const evidence = assessCandidate(reference, candidate.trajectory);
        return {
          candidate,
          alias,
          anonymized: anonymizeCandidate(candidate, alias, identifiers, deliverableChars),
          contrasts: evidence.contrasts,
          evidenceScore: evidence.score,
          adoptionRatio: clamp01(evidence.score),
          judgeRank: undefined,
          judgeRationale: undefined,
          judgeRejectedReason: undefined
        };
      });

      const aliases = evaluations.map((evaluation) => evaluation.alias);
      let judgeUnavailableReason: string | undefined;
      try {
        const modelRequest: ModelRequest = {
          purpose: 'compose',
          messages: buildJudgeMessages(request, evaluations, reference),
          temperature: options.temperature ?? 0,
          maxTokens: options.maxTokens ?? 1536,
          responseFormat: 'json',
          metadata: { sessionId: request.sessionId, candidateCount: evaluations.length, anonymous: true }
        };
        const response = await model.call(modelRequest);
        const verdict = readJudgeVerdict(response.text, aliases);
        if (verdict === undefined) {
          judgeUnavailableReason = 'judge returned an unparseable verdict';
        } else {
          const ranked = [...verdict.ranking, ...aliases.filter((alias) => !verdict.ranking.includes(alias))];
          for (const evaluation of evaluations) {
            const rank = ranked.indexOf(evaluation.alias);
            evaluation.judgeRank = rank >= 0 ? rank + 1 : undefined;
            evaluation.judgeRationale = verdict.rationales[evaluation.alias];
            evaluation.judgeRejectedReason = verdict.rejectedReasons[evaluation.alias];
            const judgeScore = judgeScoreOf(evaluation.judgeRank, evaluations.length);
            evaluation.adoptionRatio = clamp01(
              judgeScore === undefined
                ? evaluation.evidenceScore
                : evidenceWeight * evaluation.evidenceScore + judgeWeight * judgeScore
            );
          }
        }
      } catch (error) {
        judgeUnavailableReason = 'judge call failed: ' + truncate(oneLine(String(error)), 200);
      }

      const eligible = evaluations.filter((evaluation) => evaluation.candidate.trajectory.status === 'succeeded');
      let selected: CandidateEvaluation | undefined;
      for (const evaluation of eligible) {
        if (selected === undefined || isBetter(evaluation, selected)) {
          selected = evaluation;
        }
      }

      const assessments: CandidateAssessment[] = evaluations.map((evaluation) => {
        const selectedHere = selected !== undefined && evaluation.alias === selected.alias;
        let rejectedReason = evaluation.judgeRejectedReason;
        if (!selectedHere && rejectedReason === undefined) {
          if (evaluation.candidate.trajectory.status !== 'succeeded') {
            rejectedReason =
              'trajectory status ' +
              evaluation.candidate.trajectory.status +
              ' is not succeeded; failed runs are never selected';
          } else if (selected !== undefined) {
            rejectedReason =
              'lower adoption ratio ' +
              evaluation.adoptionRatio.toFixed(4) +
              ' than ' +
              selected.alias +
              ' (' +
              selected.adoptionRatio.toFixed(4) +
              ')';
          } else {
            rejectedReason = 'no candidate succeeded; nothing selected';
          }
        }
        return {
          alias: evaluation.alias,
          branchId: evaluation.candidate.branchId,
          nodeId: evaluation.candidate.nodeId,
          selected: selectedHere,
          adoptionRatio: evaluation.adoptionRatio,
          contrasts: evaluation.contrasts,
          rationale:
            evaluation.judgeRationale ??
            'evidence score ' +
              evaluation.evidenceScore.toFixed(4) +
              ' across ' +
              evaluation.contrasts.length +
              ' behavioral dimensions',
          rejectedReason
        };
      });

      // Every evaluation is addressable under three keys: the anonymous alias the judge
      // saw, plus the candidate branchId and nodeId that Dream-RSI's surrogate scorer indexes
      // (adoptionFromComposition reads ratios[node.branchId] then ratios[node.id]). Identity
      // is still never added to the judge-facing dossier; this dictionary is internal to the
      // composition result. First writer wins, so a pathological key collision between two
      // candidates can never overwrite an existing ratio; collisions are reported in the
      // rationale instead of being resolved by silently dropping a candidate.
      const adoptionRatios: Record<string, number> = {};
      const adoptionKeyConflicts: string[] = [];
      for (const evaluation of evaluations) {
        const keys = [evaluation.alias, evaluation.candidate.branchId, evaluation.candidate.nodeId];
        for (const key of keys) {
          const existing = adoptionRatios[key];
          if (existing === undefined) {
            adoptionRatios[key] = evaluation.adoptionRatio;
          } else if (existing !== evaluation.adoptionRatio && !adoptionKeyConflicts.includes(key)) {
            adoptionKeyConflicts.push(key);
          }
        }
      }

      let composedPatch: EightSurfacePatch | null = null;
      if (selected !== undefined) {
        // The composed H* is the winning candidate applied on top of its real base patch.
        // Multi-round chains are incremental (a winner only carries its own delta), so the
        // parent round's edits must be merged back in or they are silently dropped. The base
        // is resolved from the winner's own lineage first; the reference scaffold match is only
        // a fallback for single-round compositions.
        const selectedPatch = selected.candidate.patch;
        const patchCandidateById = new Map<string, ProbeCandidate>();
        for (const candidate of ordered) {
          if (!patchCandidateById.has(candidate.patch.id)) {
            patchCandidateById.set(candidate.patch.id, candidate);
          }
        }
        // Walk the winner's complete ancestor lineage root-ward. The walk is a post-order
        // DFS with the selected patch pre-marked as visited, so cycles (P1 -> P2 -> P1), repeated
        // parent ids and parents that are not candidates all terminate deterministically, and
        // `ancestors` ends up in stable root-to-parent order with no duplicates.
        const ancestors: ProbeCandidate[] = [];
        const visited = new Set<string>([selectedPatch.id]);
        const visitAncestor = (patchId: string): void => {
          if (visited.has(patchId)) {
            return;
          }
          const candidate = patchCandidateById.get(patchId);
          if (candidate === undefined) {
            return;
          }
          visited.add(patchId);
          for (const parentId of candidate.patch.parentPatchIds ?? []) {
            visitAncestor(parentId);
          }
          ancestors.push(candidate);
        };
        for (const parentId of selectedPatch.parentPatchIds ?? []) {
          visitAncestor(parentId);
        }
        // The reference scaffold is only a fallback for single-round compositions.
        const referenceBase =
          ancestors.length === 0 && reference !== undefined
            ? patchCandidateById.get(reference.patchId)
            : undefined;
        const immediateParent = ancestors[ancestors.length - 1];
        const baseResolution: 'parent' | 'lineage' | 'reference' | undefined =
          ancestors.length > 1
            ? 'lineage'
            : ancestors.length === 1
              ? 'parent'
              : referenceBase !== undefined
                ? 'reference'
                : undefined;
        // Ancestry order (reference fallback, then root -> ... -> parent, then the winner), each
        // descendant overriding the surfaces its ancestors already edited.
        const mergeOrder: readonly EightSurfacePatch[] = [
          ...(referenceBase === undefined ? [] : [referenceBase.patch]),
          ...ancestors.map((candidate) => candidate.patch),
          selectedPatch
        ];
        let mergedEdits: EightSurfaceEdits = {};
        for (const patch of mergeOrder) {
          mergedEdits = mergeEdits(mergedEdits, patch.edits);
        }
        const parentPatchIds: string[] = [];
        for (const patchId of [
          ...ancestors.map((candidate) => candidate.patch.id),
          ...(referenceBase === undefined ? [] : [referenceBase.patch.id]),
          selectedPatch.id
        ]) {
          if (!parentPatchIds.includes(patchId)) {
            parentPatchIds.push(patchId);
          }
        }
        const sourceLessonIds: string[] = [];
        for (const patch of mergeOrder) {
          for (const lessonId of patch.sourceLessonIds ?? []) {
            if (!sourceLessonIds.includes(lessonId)) {
              sourceLessonIds.push(lessonId);
            }
          }
        }
        const lineageIds = ancestors.map((candidate) => candidate.patch.id);
        const rationale =
          'composed H* from ' +
          selected.alias +
          ' (evidence ' +
          selected.evidenceScore.toFixed(4) +
          ', adoption ' +
          selected.adoptionRatio.toFixed(4) +
          ')' +
          (ancestors.length > 1
            ? ' over lineage depth ' +
              String(ancestors.length) +
              ' [' +
              lineageIds.join(' -> ') +
              ']'
            : immediateParent !== undefined
              ? ' over parent patch ' + immediateParent.patch.id + ' (' + immediateParent.patch.label + ')'
              : referenceBase !== undefined
                ? ' over reference patch ' + referenceBase.patch.id + ' (' + referenceBase.patch.label + ')'
                : '') +
          '; dimension wins: ' +
          selected.contrasts
            .filter((contrast) => (contrast.delta ?? 0) > 0)
            .map((contrast) => contrast.dimension)
            .join(', ');
        composedPatch = {
          id: newId('patch'),
          sessionId: request.sessionId,
          branchId: selected.candidate.branchId,
          origin: 'composed',
          purpose: 'compose',
          guidance: selected.candidate.patch.guidance,
          label: 'composed:' + selected.candidate.patch.label,
          rationale,
          edits: mergedEdits,
          parentPatchIds,
          sourceLessonIds,
          createdAt: evaluatedAt,
          metadata: {
            composedFromAlias: selected.alias,
            composedFromBranchId: selected.candidate.branchId,
            composedFromNodeId: selected.candidate.nodeId,
            evidenceScore: selected.evidenceScore,
            adoptionRatio: selected.adoptionRatio,
            contrastDimensions: selected.contrasts.map((contrast) => contrast.dimension),
            basePatchId: immediateParent?.patch.id ?? referenceBase?.patch.id,
            baseResolution,
            lineageIds,
            lineageDepth: ancestors.length,
            policyId: request.policyId
          }
        };
      }

      const rationaleParts: string[] = [];
      if (selected !== undefined) {
        rationaleParts.push(
          'selected ' +
            selected.alias +
            ' (branch ' +
            selected.candidate.branchId +
            ', node ' +
            selected.candidate.nodeId +
            ') with adoption ratio ' +
            selected.adoptionRatio.toFixed(4) +
            ' and evidence score ' +
            selected.evidenceScore.toFixed(4)
        );
      } else {
        rationaleParts.push('no successful candidate; selection is null');
      }
      rationaleParts.push(
        'judged ' +
          evaluations.length +
          ' anonymous candidate(s) across ' +
          CONTRAST_DIMENSIONS.length +
          ' behavioral dimensions'
      );
      if (judgeUnavailableReason !== undefined) {
        rationaleParts.push('judge unavailable -> evidence-only adoption ratios (' + judgeUnavailableReason + ')');
      } else if (selected?.judgeRank !== undefined) {
        rationaleParts.push('judge rank of the winner: ' + selected.judgeRank);
      }
      if (adoptionKeyConflicts.length > 0) {
        rationaleParts.push('adoption key collisions kept the first writer: ' + adoptionKeyConflicts.join(', '));
      }

      return {
        selectedBranchId: selected?.candidate.branchId ?? null,
        selectedNodeId: selected?.candidate.nodeId ?? null,
        selectedTrajectoryId: selected?.candidate.trajectory.id ?? null,
        selectedPatch: selected?.candidate.patch ?? null,
        composedPatch,
        assessments,
        adoptionRatios,
        rationale: rationaleParts.join('; '),
        evaluatedAt
      };
    }
  };
}

/**
 * Audit record documenting L2 residual risk on free-text restatements.
 * Demonstrates that free-text restatement risk is explicitly recorded rather than claimed eliminated.
 */
export const ADVICE_LEAKAGE_RISK_RECORD = {
  policy: 'L2_structured_advice_stripping',
  eliminated: 'structured_xml_tags',
  residualRisk: 'free_text_restatement_cannot_be_eliminated_by_xml_stripping_alone',
  recommendation: 'audit_judge_inputs_and_apply_whitelist_filtering'
} as const;
