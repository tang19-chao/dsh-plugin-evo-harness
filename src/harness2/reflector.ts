/**
 * Harness² evidence-chain reflector: turns completed probes into canonical
 * positive and negative lessons (ARCHITECTURE.md §4.1 and §7.5).
 *
 * Every emitted lesson is a complete CanonicalLesson: the six CCG elements
 * (title, whenToApply, subFunctions, executionPatch, verificationEvidence,
 * whenNotToApply) are always present and non-empty, built from the observed
 * trajectory contrast rather than from model prose. The injected model adapter
 * may only refine the title and add extra applicability/restraint clauses; it
 * can never remove a deterministic clause or invent evidence.
 *
 * verificationEvidence.candidateSuccess records the observed candidate outcome
 * verbatim ("candidate succeeded" / "candidate did not complete"), so negative
 * lessons keep an honest evidence chain instead of claiming a success that never
 * happened.
 *
 * A candidate whose patch body cannot be identified at all (no surface keys and
 * no patch record) is skipped with a diagnostic instead of being turned into an
 * unverifiable lesson.
 */

import {
  type BehavioralContrast,
  type CanonicalLesson,
  type CandidateAssessment,
  type ContractMetadata,
  type DiscoveryNode,
  type EightSurfacePatch,
  type HarnessComponentKey,
  type IHarnessReflector,
  type IModelAdapter,
  type LessonExecutionPatch,
  type LessonMetricsDelta,
  type LessonPolarity,
  type LessonVerificationEvidence,
  type LessonVisibility,
  type ModelMessage,
  type ModelRequest,
  type ProbeTrajectory,
  type ReflectionRequest,
  type ReflectionResult
} from '../types/contracts';
// P3-B: every model call leaves this module through the unified metered boundary.
import { createMeteredModelAdapter, type MeteredModelOptions } from '../dsh-bridge/metered-model-adapter';
import {
  type Clock,
  type IdFactory,
  clamp01,
  createDeterministicIdFactory,
  isRecord,
  nonEmptyString,
  oneLine,
  readStringList,
  surfaceEditSummary,
  surfaceKeysInOrder,
  systemClock,
  truncate,
  extractJsonValue
} from './shared';

/** Injectable dependencies of the evidence reflector. */
export interface HarnessReflectorOptions {
  /** Host-neutral LLM boundary used to refine lesson headers. */
  readonly model: IModelAdapter;
  /** P3-B metering wiring (ledger/registry); absent records calls without cost. */
  readonly metering?: MeteredModelOptions;
  /** Injected clock; defaults to Date.now(). */
  readonly now?: Clock;
  /** Injected id factory; defaults to a deterministic counter. */
  readonly newId?: IdFactory;
  /** Header-refinement temperature; defaults to 0. */
  readonly temperature?: number;
  /** Header-refinement token cap; defaults to 1536. */
  readonly maxTokens?: number;
  /** Cap on applicability / restraint clauses per lesson; defaults to 8. */
  readonly maxClauses?: number;
}

interface CandidateDossier {
  readonly trajectory: ProbeTrajectory;
  readonly polarity: LessonPolarity;
  readonly assessment: CandidateAssessment | undefined;
  readonly node: DiscoveryNode | undefined;
  readonly patch: EightSurfacePatch | undefined;
  readonly surfaces: readonly HarnessComponentKey[];
  readonly contrasts: readonly BehavioralContrast[];
  readonly metricsDelta: LessonMetricsDelta;
  readonly referenceFailure: string;
  readonly candidateOutcome: string;
  readonly cues: readonly string[];
  readonly clauses: readonly string[];
  readonly title: string;
  readonly summary: string;
  readonly componentDiffs: Readonly<Record<string, string>> | undefined;
  readonly confidence: number;
  readonly tags: readonly string[];
}

interface AssistedHeader {
  readonly title?: string;
  readonly whenToApply: readonly string[];
  readonly whenNotToApply: readonly string[];
}

/**
 * Visibility mirrors the scope the caller will commit into. Polarity handling
 * (negative firewall, anti-pattern channel separation) belongs to the memory
 * bridge per ARCHITECTURE.md §4.3, so negative lessons inherit the same scope.
 */
function visibilityFor(scope: ReflectionRequest['scope']): LessonVisibility {
  switch (scope.kind) {
    case 'global':
      return 'global';
    case 'session':
      return 'session';
    case 'branch':
    default:
      return 'branch_private';
  }
}

function dedupeTrajectories(trajectories: readonly ProbeTrajectory[]): ProbeTrajectory[] {
  const seen = new Set<string>();
  const out: ProbeTrajectory[] = [];
  for (const trajectory of trajectories) {
    if (!seen.has(trajectory.id)) {
      seen.add(trajectory.id);
      out.push(trajectory);
    }
  }
  return out;
}

function isEightSurfacePatch(value: unknown): value is EightSurfacePatch {
  if (!isRecord(value)) {
    return false;
  }
  return (
    nonEmptyString(value.id) !== undefined &&
    nonEmptyString(value.sessionId) !== undefined &&
    nonEmptyString(value.branchId) !== undefined &&
    isRecord(value.edits)
  );
}

function collectPatches(
  request: ReflectionRequest,
  diagnostics: string[]
): ReadonlyMap<string, EightSurfacePatch> {
  const patches = new Map<string, EightSurfacePatch>();
  if (request.composition.selectedPatch !== null) {
    patches.set(request.composition.selectedPatch.id, request.composition.selectedPatch);
  }
  if (request.composition.composedPatch !== null) {
    patches.set(request.composition.composedPatch.id, request.composition.composedPatch);
  }
  const raw: unknown = request.metadata?.candidatePatches;
  const list: unknown[] = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : [];
  if (raw !== undefined && list.length === 0) {
    diagnostics.push(
      'metadata.candidatePatches was provided but is neither an array nor a record; patch bodies are unavailable'
    );
  }
  for (const item of list) {
    if (isEightSurfacePatch(item)) {
      patches.set(item.id, item);
    }
  }
  return patches;
}

function describeReference(reference: ProbeTrajectory | undefined): string {
  if (reference === undefined) {
    return 'no reference trajectory was recorded; deltas are measured against a zero-execution baseline';
  }
  const parts: string[] = [];
  parts.push(reference.status === 'succeeded' ? 'reference run succeeded' : 'reference run did not complete');
  parts.push('status=' + reference.status);
  parts.push('steps=' + reference.metrics.steps);
  parts.push('toolErrors=' + reference.metrics.toolErrors);
  if (reference.error !== undefined) {
    parts.push('error=' + reference.error.name + ': ' + truncate(oneLine(reference.error.message), 160));
  }
  if (reference.failureSignals.length > 0) {
    const first = reference.failureSignals[0];
    if (first !== undefined) {
      parts.push('firstSignal=' + first.kind + ': ' + truncate(oneLine(first.message), 160));
    }
  }
  return parts.join('; ');
}

function describeCandidateOutcome(candidate: ProbeTrajectory): string {
  const parts: string[] = [];
  parts.push(candidate.status === 'succeeded' ? 'candidate succeeded' : 'candidate did not complete');
  parts.push('status=' + candidate.status);
  parts.push('steps=' + candidate.metrics.steps);
  parts.push('toolErrors=' + candidate.metrics.toolErrors);
  if (candidate.error !== undefined) {
    parts.push('error=' + candidate.error.name + ': ' + truncate(oneLine(candidate.error.message), 160));
  } else if (candidate.failureSignals.length > 0) {
    const first = candidate.failureSignals[0];
    if (first !== undefined) {
      parts.push('firstSignal=' + first.kind + ': ' + truncate(oneLine(first.message), 160));
    }
  }
  if (candidate.deliverable !== undefined) {
    parts.push('deliverableChars=' + candidate.deliverable.content.length);
  } else {
    parts.push('no deliverable');
  }
  return parts.join('; ');
}

function applicabilityCues(
  request: ReflectionRequest,
  polarity: LessonPolarity,
  surfaces: readonly HarnessComponentKey[],
  node: DiscoveryNode | undefined,
  reference: ProbeTrajectory | undefined,
  candidate: ProbeTrajectory,
  maxClauses: number
): string[] {
  const cues: string[] = [];
  if (request.task.taskSignature !== undefined) {
    cues.push('taskSignature=' + request.task.taskSignature);
  } else {
    cues.push('taskPrompt~' + truncate(oneLine(request.task.prompt), 80));
  }
  cues.push('taskComplexity=' + (request.task.complexity ?? 'unknown'));
  if (node?.slot !== undefined) {
    cues.push('slot=' + node.slot);
  }
  for (const tag of (request.task.contextTags ?? []).slice(0, 3)) {
    cues.push('contextTag=' + tag);
  }
  for (const surface of surfaces.slice(0, 3)) {
    cues.push('requiresSurface=' + surface);
  }
  // A positive lesson is triggered by the reference failure it repairs; a negative lesson is
  // triggered by the candidate's own observed failure signal.
  const signal: string | undefined =
    polarity === 'positive'
      ? reference?.failureSignals[0]?.kind
      : candidate.failureSignals[0]?.kind;
  if (signal !== undefined) {
    cues.push((polarity === 'positive' ? 'referenceSignal=' : 'observedSignal=') + signal);
  } else if (polarity === 'negative') {
    cues.push('observedStatus=' + candidate.status);
  }
  return cues.slice(0, maxClauses);
}

function restraintClauses(
  request: ReflectionRequest,
  polarity: LessonPolarity,
  surfaces: readonly HarnessComponentKey[],
  patch: EightSurfacePatch | undefined,
  maxClauses: number
): string[] {
  const clauses: string[] = [];
  if (request.task.taskSignature !== undefined) {
    clauses.push('do not apply when the target taskSignature differs from ' + request.task.taskSignature);
  } else {
    clauses.push('do not apply to tasks whose prompt is not comparable to this probe');
  }
  if (request.task.complexity === 'complex') {
    clauses.push('do not apply to trivial or simple tasks where the added scaffold cost is not justified');
  }
  clauses.push('do not apply when the reference failure signals of this probe are absent from the target run');
  if (polarity === 'negative') {
    clauses.push(
      'anti-pattern warning only: never inject as a recommendation; the failure may be a transient sandbox or tooling fault rather than a harness design fault'
    );
  } else {
    clauses.push('do not stack on top of a higher-confidence recalled lesson that already covers the same surface');
  }
  if (surfaces.includes('scripts')) {
    clauses.push('do not apply when the target sandbox has no runtime for the mounted script language');
  }
  if (surfaces.includes('plugins')) {
    clauses.push('do not apply when tool-loop middleware hooks are unavailable in the target host');
  }
  if (patch?.guidance === 'guidance_free') {
    clauses.push(
      'do not use as a substitute for recalled domain lessons when high-confidence memory already matches the task (this lesson is guidance-free)'
    );
  }
  return clauses.slice(0, maxClauses);
}

function defaultTitle(
  polarity: LessonPolarity,
  surfaces: readonly HarnessComponentKey[],
  patch: EightSurfacePatch | undefined,
  signature: string | undefined
): string {
  const what = patch !== undefined ? patch.label : surfaces.join('+');
  const scope = signature !== undefined ? ' for ' + signature : '';
  return (polarity === 'positive' ? 'Adopt ' : 'Avoid ') + what + scope;
}

function executionSummary(
  polarity: LessonPolarity,
  patch: EightSurfacePatch | undefined,
  surfaces: readonly HarnessComponentKey[],
  contrasts: readonly BehavioralContrast[]
): string {
  if (patch !== undefined && patch.rationale.trim().length > 0) {
    return truncate(oneLine(patch.rationale), 300);
  }
  const deltas = contrasts
    .map((contrast) => contrast.dimension + (contrast.delta === undefined ? '' : '=' + contrast.delta))
    .join(', ');
  return (
    (polarity === 'positive'
      ? 'Apply the observed winning edit on '
      : 'Do not repeat the observed failing edit on ') +
    surfaces.join(', ') +
    '; observed deltas: ' +
    deltas
  );
}

function componentDiffsOf(patch: EightSurfacePatch | undefined): Record<string, string> | undefined {
  if (patch === undefined) {
    return undefined;
  }
  const diffs: Record<string, string> = {};
  for (const key of surfaceKeysInOrder(Object.keys(patch.edits))) {
    diffs[key] = surfaceEditSummary(patch.edits[key]);
  }
  return Object.keys(diffs).length > 0 ? diffs : undefined;
}

function lessonConfidence(
  polarity: LessonPolarity,
  assessment: CandidateAssessment | undefined,
  reference: ProbeTrajectory | undefined,
  candidate: ProbeTrajectory
): number {
  const referenceErrors = reference?.metrics.toolErrors ?? 0;
  const errorRelief = clamp01(
    0.5 + (referenceErrors - candidate.metrics.toolErrors) / (2 * Math.max(1, referenceErrors + 1))
  );
  const base = polarity === 'positive' ? 0.6 : 0.4;
  return clamp01(0.7 * (assessment?.adoptionRatio ?? base) + 0.3 * errorRelief);
}

function tagsFor(
  polarity: LessonPolarity,
  surfaces: readonly HarnessComponentKey[],
  node: DiscoveryNode | undefined,
  patch: EightSurfacePatch | undefined
): string[] {
  const tags: string[] = ['harness2', polarity === 'negative' ? 'anti_pattern' : 'recommendation'];
  if (node?.slot !== undefined) {
    tags.push('slot=' + node.slot);
  }
  if (patch !== undefined) {
    tags.push('purpose=' + patch.purpose);
    tags.push('origin=' + patch.origin);
  }
  for (const surface of surfaces.slice(0, 3)) {
    tags.push('surface=' + surface);
  }
  return tags;
}

/**
 * True when this trajectory is the candidate the composer selected. The composed H* is a
 * fresh patch id that no trajectory carries, so a winner must be identified by the
 * composition's selected trajectory/node, never by patch id lookup.
 */
function isSelectedWinner(request: ReflectionRequest, trajectory: ProbeTrajectory): boolean {
  const composition = request.composition;
  if (composition.selectedTrajectoryId !== null && composition.selectedTrajectoryId === trajectory.id) {
    return true;
  }
  return (
    composition.selectedNodeId !== null &&
    trajectory.nodeId !== undefined &&
    composition.selectedNodeId === trajectory.nodeId
  );
}

function buildDossier(
  request: ReflectionRequest,
  trajectory: ProbeTrajectory,
  reference: ProbeTrajectory | undefined,
  patches: ReadonlyMap<string, EightSurfacePatch>,
  maxClauses: number
): CandidateDossier | undefined {
  // The selected winner's evidence is the composed H* (ancestry merged), not its own
  // incremental patch, so its lesson records the edits that were actually mounted. Every
  // other candidate keeps its own patch, and a null composedPatch falls back to the
  // trajectory patch exactly as before.
  const composedPatch = request.composition.composedPatch;
  const patch =
    isSelectedWinner(request, trajectory) && composedPatch !== null
      ? composedPatch
      : patches.get(trajectory.patchId);
  const fromTrajectory = surfaceKeysInOrder(trajectory.surfaceKeys);
  const surfaces = fromTrajectory.length > 0 ? fromTrajectory : patch !== undefined ? surfaceKeysInOrder(Object.keys(patch.edits)) : [];
  if (surfaces.length === 0) {
    return undefined;
  }
  const assessment = request.composition.assessments.find(
    (candidate) => candidate.nodeId === trajectory.nodeId || candidate.branchId === trajectory.branchId
  );
  const node = trajectory.nodeId !== undefined ? request.tree.nodes[trajectory.nodeId] : undefined;
  const polarity: LessonPolarity = trajectory.status === 'succeeded' ? 'positive' : 'negative';
  const referenceSteps = reference?.metrics.steps ?? 0;
  const referenceErrors = reference?.metrics.toolErrors ?? 0;
  const metricsDelta: LessonMetricsDelta = {
    stepsDiff: trajectory.metrics.steps - referenceSteps,
    toolErrorsDiff: trajectory.metrics.toolErrors - referenceErrors
  };
  const contrasts = assessment?.contrasts ?? [];
  return {
    trajectory,
    polarity,
    assessment,
    node,
    patch,
    surfaces,
    contrasts,
    metricsDelta,
    referenceFailure: describeReference(reference),
    candidateOutcome: describeCandidateOutcome(trajectory),
    cues: applicabilityCues(request, polarity, surfaces, node, reference, trajectory, maxClauses),
    clauses: restraintClauses(request, polarity, surfaces, patch, maxClauses),
    title: defaultTitle(polarity, surfaces, patch, request.task.taskSignature),
    summary: executionSummary(polarity, patch, surfaces, contrasts),
    componentDiffs: componentDiffsOf(patch),
    confidence: lessonConfidence(polarity, assessment, reference, trajectory),
    tags: tagsFor(polarity, surfaces, node, patch)
  };
}

function buildHeaderMessages(
  request: ReflectionRequest,
  dossiers: readonly CandidateDossier[],
  reference: ProbeTrajectory | undefined
): readonly ModelMessage[] {
  const system: string[] = [];
  system.push('You are the Harness² evidence reflector for a DeepSeek Harness (Cordis) agent.');
  system.push(
    'Each dossier is a completed probe with verified behavioral evidence. Produce one canonical lesson header per dossier.'
  );
  system.push(
    'Rules: never invent evidence; never contradict the recorded outcome; keep every provided trigger cue and restraint clause (you may add more, not fewer); negative lessons are anti-patterns and must never read as recommendations.'
  );
  system.push('Return exactly ONE JSON object, no prose:');
  system.push(
    '{ "lessons": [{ "candidateId": string, "title": string, "whenToApply": string[], "whenNotToApply": string[] }] }'
  );
  const user: string[] = [];
  user.push('## Task');
  user.push('prompt: ' + truncate(oneLine(request.task.prompt), 800));
  if (request.task.taskSignature !== undefined) {
    user.push('taskSignature: ' + request.task.taskSignature);
  }
  user.push('scope: ' + request.scope.kind);
  if (reference !== undefined) {
    user.push('referenceTrajectoryId: ' + reference.id);
  }
  user.push('');
  user.push('## Dossiers (' + dossiers.length + ')');
  for (const dossier of dossiers) {
    user.push('');
    user.push('### candidateId=' + dossier.trajectory.id);
    user.push('polarity: ' + dossier.polarity);
    user.push('status: ' + dossier.trajectory.status);
    user.push('surfaces: ' + dossier.surfaces.join(', '));
    user.push('referenceFailure: ' + dossier.referenceFailure);
    user.push('candidateOutcome: ' + dossier.candidateOutcome);
    user.push(
      'metricsDelta: stepsDiff=' +
        dossier.metricsDelta.stepsDiff +
        ' toolErrorsDiff=' +
        dossier.metricsDelta.toolErrorsDiff
    );
    if (dossier.contrasts.length > 0) {
      user.push('behavioralContrasts:');
      for (const contrast of dossier.contrasts) {
        user.push(
          '  - ' +
            contrast.dimension +
            ': reference=' +
            String(contrast.referenceValue) +
            ' candidate=' +
            String(contrast.candidateValue) +
            (contrast.delta === undefined ? '' : ' delta=' + contrast.delta)
        );
      }
    }
    user.push('requiredWhenToApply: ' + dossier.cues.join(' | '));
    user.push('requiredWhenNotToApply: ' + dossier.clauses.join(' | '));
  }
  user.push('');
  user.push('## Output');
  user.push('Return the single JSON header object now.');
  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: user.join('\n') }
  ];
}

function readAssistedHeaders(text: string): ReadonlyMap<string, AssistedHeader> {
  const headers = new Map<string, AssistedHeader>();
  const parsed = extractJsonValue(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.lessons)) {
    return headers;
  }
  for (const item of parsed.lessons) {
    if (!isRecord(item)) {
      continue;
    }
    const candidateId = nonEmptyString(item.candidateId);
    if (candidateId === undefined) {
      continue;
    }
    headers.set(candidateId, {
      title: nonEmptyString(item.title),
      whenToApply: readStringList(item.whenToApply, 16) ?? [],
      whenNotToApply: readStringList(item.whenNotToApply, 16) ?? []
    });
  }
  return headers;
}

function unionClauses(primary: readonly string[], extra: readonly string[], max: number): string[] {
  const out: string[] = [];
  for (const value of [...primary, ...extra]) {
    if (value.trim().length > 0 && !out.includes(value)) {
      out.push(value);
    }
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

function duplicateKey(lesson: CanonicalLesson): string {
  const firstCue = lesson.whenToApply[0] ?? '';
  return lesson.polarity + '|' + lesson.subFunctions.join(',') + '|' + firstCue;
}

function recalledDuplicateOf(
  request: ReflectionRequest,
  lesson: CanonicalLesson
): CanonicalLesson | undefined {
  const recalled: readonly CanonicalLesson[] = [
    ...(request.recall?.positiveLessons ?? []),
    ...(request.recall?.negativeLessons ?? [])
  ];
  const key = lesson.title.trim().toLowerCase();
  return recalled.find((candidate) => candidate.title.trim().toLowerCase() === key);
}

/**
 * Build the evidence-backed reflector. The returned object implements the
 * frozen IHarnessReflector contract; the model adapter can only refine headers
 * and all I/O stays injected.
 */
export function createEvidenceReflector(options: HarnessReflectorOptions): IHarnessReflector {
  const now = options.now ?? systemClock;
  const newId = options.newId ?? createDeterministicIdFactory('reflect');
  const maxClauses = options.maxClauses ?? 8;
  const model = createMeteredModelAdapter(options.model, 'reflect', options.metering);

  return {
    async reflect(request: ReflectionRequest): Promise<ReflectionResult> {
      const diagnostics: string[] = [];
      const all = dedupeTrajectories(request.trajectories);
      const reference =
        request.referenceTrajectory ?? all.find((trajectory) => trajectory.role === 'reference');
      let candidates = all.filter((trajectory) => trajectory.role === 'candidate');
      if (candidates.length === 0) {
        const fallback = all.filter((trajectory) => trajectory.id !== reference?.id);
        if (fallback.length > 0) {
          candidates = fallback;
          diagnostics.push(
            'no trajectory carried role=candidate; reflection fell back to every non-reference trajectory'
          );
        }
      }
      if (candidates.length === 0) {
        diagnostics.push('no candidate trajectories were supplied; nothing to reflect on');
        return { lessons: [], positiveCount: 0, negativeCount: 0, diagnostics };
      }

      const patches = collectPatches(request, diagnostics);
      const dossiers: CandidateDossier[] = [];
      for (const candidate of candidates) {
        const dossier = buildDossier(request, candidate, reference, patches, maxClauses);
        if (dossier === undefined) {
          diagnostics.push(
            'candidate ' +
              candidate.id +
              ' has no recorded surface keys and no patch body; skipped instead of emitting an unverifiable lesson'
          );
          continue;
        }
        if (dossier.node === undefined && candidate.nodeId !== undefined) {
          diagnostics.push('candidate ' + candidate.id + ' node ' + candidate.nodeId + ' is absent from the tree snapshot');
        }
        dossiers.push(dossier);
      }
      if (dossiers.length === 0) {
        diagnostics.push('no candidate produced enough evidence for a canonical lesson');
        return { lessons: [], positiveCount: 0, negativeCount: 0, diagnostics };
      }

      let headers: ReadonlyMap<string, AssistedHeader> = new Map();
      try {
        const modelRequest: ModelRequest = {
          purpose: 'reflect',
          messages: buildHeaderMessages(request, dossiers, reference),
          temperature: options.temperature ?? 0,
          maxTokens: options.maxTokens ?? 1536,
          responseFormat: 'json',
          metadata: { sessionId: request.sessionId, dossierCount: dossiers.length, scope: request.scope.kind }
        };
        const response = await model.call(modelRequest);
        headers = readAssistedHeaders(response.text);
        if (headers.size === 0) {
          diagnostics.push('model header refinement returned no usable lesson headers; deterministic headers were used');
        }
      } catch (error) {
        diagnostics.push('model header refinement failed; deterministic headers were used: ' + truncate(oneLine(String(error)), 160));
      }

      const createdAt = now();
      const lessons: CanonicalLesson[] = [];
      for (const dossier of dossiers) {
        const assisted = headers.get(dossier.trajectory.id);
        const title = assisted?.title ?? dossier.title;
        const whenToApply = unionClauses(dossier.cues, assisted?.whenToApply ?? [], maxClauses);
        const whenNotToApply = unionClauses(dossier.clauses, assisted?.whenNotToApply ?? [], maxClauses);
        const executionPatch: LessonExecutionPatch = {
          summary: dossier.summary,
          componentDiffs: dossier.componentDiffs,
          patchId: dossier.trajectory.patchId
        };
        const verificationEvidence: LessonVerificationEvidence = {
          referenceFailure: dossier.referenceFailure,
          candidateSuccess: dossier.candidateOutcome,
          metricsDelta: dossier.metricsDelta,
          referenceTrajectoryId: reference?.id,
          candidateTrajectoryId: dossier.trajectory.id
        };
        const metadata: ContractMetadata = {
          nodeId: dossier.trajectory.nodeId,
          nodeStatus: dossier.node?.status,
          treeId: request.tree.id,
          branchId: dossier.trajectory.branchId,
          patchId: dossier.trajectory.patchId,
          patchOrigin: dossier.trajectory.patchOrigin,
          guidanceMode: dossier.patch?.guidance,
          adoptionRatio: dossier.assessment?.adoptionRatio,
          contrastDimensions: dossier.contrasts.map((contrast) => contrast.dimension),
          headerSource: assisted?.title !== undefined ? 'model' : 'deterministic'
        };
        lessons.push({
          id: newId('lesson'),
          title: truncate(title, 160),
          whenToApply,
          subFunctions: [...dossier.surfaces],
          executionPatch,
          verificationEvidence,
          whenNotToApply,
          polarity: dossier.polarity,
          visibility: visibilityFor(request.scope),
          sessionId: request.sessionId,
          branchId: request.scope.kind === 'branch' ? request.scope.branchId : dossier.trajectory.branchId,
          schemaVersion: 1,
          createdAt,
          tags: [...dossier.tags],
          confidence: dossier.confidence,
          taskSignature: request.task.taskSignature,
          sourceTreeId: request.tree.id,
          metadata
        });
      }

      const deduped: CanonicalLesson[] = [];
      const byKey = new Map<string, number>();
      for (const lesson of lessons) {
        const key = duplicateKey(lesson);
        const existingIndex = byKey.get(key);
        if (existingIndex === undefined) {
          byKey.set(key, deduped.length);
          deduped.push(lesson);
          continue;
        }
        const existing = deduped[existingIndex];
        diagnostics.push('duplicate lesson key ' + key + ' merged into ' + String(existing?.id));
        if (existing !== undefined && (lesson.confidence ?? 0) > (existing.confidence ?? 0)) {
          deduped[existingIndex] = lesson;
        }
      }

      for (let index = 0; index < deduped.length; index += 1) {
        const lesson = deduped[index];
        if (lesson === undefined) {
          continue;
        }
        const recalled = recalledDuplicateOf(request, lesson);
        if (recalled !== undefined) {
          diagnostics.push(
            'lesson ' + lesson.id + ' restates recalled lesson ' + recalled.id + '; the memory bridge decides on deduplication'
          );
          deduped[index] = { ...lesson, metadata: { ...lesson.metadata, recalledDuplicateOf: recalled.id } };
        }
      }

      const positiveCount = deduped.filter((lesson) => lesson.polarity === 'positive').length;
      return {
        lessons: deduped,
        positiveCount,
        negativeCount: deduped.length - positiveCount,
        diagnostics
      };
    }
  };
}
