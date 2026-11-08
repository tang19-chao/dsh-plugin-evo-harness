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
  normalizePathForFingerprint,
  oneLine,
  readStringList,
  surfaceEditSummary,
  surfaceKeysInOrder,
  systemClock,
  truncate,
  extractJsonValue
} from './shared';
// Harness2 #37 content-layer port: every free-text dossier field handed to the
// model passes the shared secret redaction before it leaves the process
// boundary (same discipline as src/mcp/server.ts redactForBoundary).
import { redactSecrets } from '../jitrl/redaction';

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

interface ReflectionTripwireHit {
  readonly field: string;
}

/**
 * Upstream #163's grader-verdict tripwire, adapted to this repository's
 * in-memory reflection boundary (the upstream PR scans the reflection tree
 * before it can be rolled or stored; here the same scan runs on the model
 * headers, the patch/trajectory evidence and the assembled lesson). The
 * upstream marker list is kept verbatim apart from dropping the JSON quote
 * characters: parsed object fields no longer carry them, and the scan must
 * stay fail-closed. The marker names are deliberately not copied into
 * diagnostics or lessons: this is a leak guard, not a sanitizer.
 */
const GRADER_VERDICT_MARKERS: readonly string[] = [
  'deterministic_eval_summary',
  'deterministic_eval_result',
  'judge_scope_and_deterministic_status',
  'judge findings on the rendered result',
  'passed_count',
  'pass_rate',
  'test_pass_rate'
];

/**
 * Answer-key / golden-output path shapes, checked ONLY on path-bearing fields
 * (`path`, `producedFiles`) after POSIX normalization, so `dir\answer_key.json`
 * and `dir/answer_key.json` are caught identically on every platform. Prose is
 * never path-matched: a lesson that merely mentions an answer key in its body
 * is a content matter for the marker scan, not this structural one.
 */
const ANSWER_KEY_DIR_PATTERN = /(?:^|[/\\])(?:answer[-_ ]?keys?|gold(?:en)?(?:[-_ ]?(?:answers?|outputs?))?|expected[-_ ]?outputs?|grader[-_ ]?verdicts?)(?:[/\\]|$)/i;
const ANSWER_KEY_FILE_PATTERN = /(?:^|[/\\])(?:answer[-_ ]?key|gold(?:en)?(?:[-_ ]?(?:answer|output))?|expected[-_ ]?output|grader[-_ ]?verdict)\.[a-z0-9]+$/i;

function answerKeyPathHit(value: unknown): boolean {
  if (typeof value === 'string') {
    const normalized = normalizePathForFingerprint(value);
    return ANSWER_KEY_DIR_PATTERN.test(normalized) || ANSWER_KEY_FILE_PATTERN.test(normalized);
  }
  if (Array.isArray(value)) {
    return value.some(answerKeyPathHit);
  }
  return false;
}

function reflectionTripwireHit(value: unknown, field: string): ReflectionTripwireHit | undefined {
  if (typeof value === 'string') {
    const marker = GRADER_VERDICT_MARKERS.find((candidate) => value.toLowerCase().includes(candidate));
    return marker === undefined ? undefined : { field };
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = reflectionTripwireHit(value[index], field + '[' + index + ']');
      if (hit !== undefined) {
        return hit;
      }
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      // Structural answer-key check applies only to path-bearing fields.
      if ((key === 'path' || key === 'producedFiles') && answerKeyPathHit(item)) {
        return { field: field + '.' + key };
      }
      const hit = reflectionTripwireHit(item, field + '.' + key);
      if (hit !== undefined) {
        return hit;
      }
    }
  }
  return undefined;
}

interface CollectedPatches {
  readonly patches: ReadonlyMap<string, EightSurfacePatch>;
  /** Patch bodies the tripwire refused; candidates mounted on them are skipped. */
  readonly rejectedPatchIds: ReadonlySet<string>;
}

function collectPatches(
  request: ReflectionRequest,
  diagnostics: string[]
): CollectedPatches {
  const patches = new Map<string, EightSurfacePatch>();
  const rejectedPatchIds = new Set<string>();
  const add = (patch: EightSurfacePatch): void => {
    // The whole patch record is screened: label and rationale cross into the
    // lesson header prompt and the lesson body, not only the edit payloads.
    const hit = reflectionTripwireHit(patch, 'patch ' + patch.id);
    if (hit !== undefined) {
      rejectedPatchIds.add(patch.id);
      diagnostics.push(
        'reflection tripwire rejected patch ' + patch.id + ' (' + hit.field + '); patch skipped instead of poisoning the lesson evidence'
      );
      return;
    }
    patches.set(patch.id, patch);
  };
  if (request.composition.selectedPatch !== null) {
    add(request.composition.selectedPatch);
  }
  if (request.composition.composedPatch !== null) {
    add(request.composition.composedPatch);
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
      add(item);
    }
  }
  return { patches, rejectedPatchIds };
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

/**
 * The free-text/structured evidence of one probe that can reach a lesson or
 * the header prompt. Both the skip decision (buildDossier) and the audit
 * diagnostic in reflect() scan EXACTLY this projection, so the two can never
 * disagree about why a candidate was dropped.
 */
function trajectoryEvidence(trajectory: ProbeTrajectory): Record<string, unknown> {
  return {
    surfaceKeys: trajectory.surfaceKeys,
    steps: trajectory.steps,
    toolErrors: trajectory.toolErrors,
    deliverable: trajectory.deliverable,
    failureSignals: trajectory.failureSignals,
    error: trajectory.error,
    metadata: trajectory.metadata
  };
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
  // The trajectory itself is untrusted model/tool output too. A poisoned probe
  // must not be kept alive merely because its surfaceKeys came from the probe.
  const trajectoryHit = reflectionTripwireHit(trajectoryEvidence(trajectory), 'trajectory ' + trajectory.id);
  if (trajectoryHit !== undefined) {
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
  // Harness2 #37 content layer: the dossier is model input, so every free-text
  // field is secret-redacted here — the single seam where trajectory evidence
  // becomes a prompt. Deterministic lesson fields keep their original text;
  // only what crosses the model boundary is redacted.
  const secretFree = (text: string): string => redactSecrets(text);
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
  user.push('prompt: ' + secretFree(truncate(oneLine(request.task.prompt), 800)));
  if (request.task.taskSignature !== undefined) {
    user.push('taskSignature: ' + secretFree(request.task.taskSignature));
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
    user.push('referenceFailure: ' + secretFree(dossier.referenceFailure));
    user.push('candidateOutcome: ' + secretFree(dossier.candidateOutcome));
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
            (contrast.delta === undefined ? '' : ' delta=' + contrast.delta) +
            (contrast.evidence.length === 0
              ? ''
              : ' | ' + secretFree(contrast.evidence.join('; ')))
        );
      }
    }
    user.push(
      'requiredWhenToApply: ' + secretFree(dossier.cues.join(' | '))
    );
    user.push(
      'requiredWhenNotToApply: ' + secretFree(dossier.clauses.join(' | '))
    );
  }
  user.push('');
  user.push('## Output');
  user.push('Return the single JSON header object now.');
  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: user.join('\n') }
  ];
}

function readAssistedHeaders(
  text: string,
  dossiers: readonly CandidateDossier[],
  diagnostics: string[]
): ReadonlyMap<string, AssistedHeader> {
  const headers = new Map<string, AssistedHeader>();
  const parsed = extractJsonValue(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.lessons)) {
    return headers;
  }
  const knownIds = new Set(dossiers.map((dossier) => dossier.trajectory.id));
  for (const item of parsed.lessons) {
    if (!isRecord(item)) {
      continue;
    }
    const candidateId = nonEmptyString(item.candidateId);
    if (candidateId === undefined || !knownIds.has(candidateId)) {
      continue;
    }
    const hit = reflectionTripwireHit(item, 'model header ' + candidateId);
    if (hit !== undefined) {
      diagnostics.push(
        'reflection tripwire rejected model header for ' + candidateId + ' (' + hit.field + '); deterministic header used for this lesson'
      );
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
      // Upstream #163 degradation seam: a tripwire firing on the reflection
      // INPUT must never crash the run, and must never be laundered into a
      // success. The task prompt is echoed into lesson cues and the header
      // prompt, so poisoned task material degrades the WHOLE reflection to an
      // honest empty result with a diagnostic naming the field.
      const inputHit = reflectionTripwireHit(
        { prompt: request.task.prompt, taskSignature: request.task.taskSignature },
        'task input'
      );
      if (inputHit !== undefined) {
        diagnostics.push(
          'reflection tripwire rejected reflection input (' + inputHit.field + '); no lessons emitted and the run continues'
        );
        return { lessons: [], positiveCount: 0, negativeCount: 0, diagnostics };
      }
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

      const { patches, rejectedPatchIds } = collectPatches(request, diagnostics);
      const dossiers: CandidateDossier[] = [];
      for (const candidate of candidates) {
        // A candidate mounted on a refused patch body has an uninspectable
        // intervention: emit neither lesson nor a silent fallback for it.
        if (rejectedPatchIds.has(candidate.patchId)) {
          diagnostics.push(
            'reflection tripwire rejected candidate ' + candidate.id + ' patch ' + candidate.patchId + '; no lesson emitted'
          );
          continue;
        }
        const dossier = buildDossier(request, candidate, reference, patches, maxClauses);
        if (dossier === undefined) {
          const tripwire = reflectionTripwireHit(trajectoryEvidence(candidate), 'trajectory ' + candidate.id);
          if (tripwire !== undefined) {
            diagnostics.push(
              'reflection tripwire rejected candidate ' + candidate.id + ' (' + tripwire.field + '); no lesson emitted'
            );
          } else {
            diagnostics.push(
              'candidate ' +
                candidate.id +
                ' has no recorded surface keys and no patch body; skipped instead of emitting an unverifiable lesson'
            );
          }
          continue;
        }
        if (dossier.node === undefined && candidate.nodeId !== undefined) {
          diagnostics.push('candidate ' + candidate.id + ' node ' + candidate.nodeId + ' is absent from the tree snapshot');
        }
        dossiers.push(dossier);
      }
      if (dossiers.length === 0) {
        diagnostics.push(
          diagnostics.some((entry) => entry.startsWith('reflection tripwire'))
            ? 'every candidate was rejected by the reflection tripwire; no lessons emitted'
            : 'no candidate produced enough evidence for a canonical lesson'
        );
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
        headers = readAssistedHeaders(response.text, dossiers, diagnostics);
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
        const lesson: CanonicalLesson = {
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
        };
        // Last boundary before the memory bridge: model refinements are already
        // screened above, but deterministic fields and future additions remain
        // fail-closed here. Degrade this lesson only; never throw away the run.
        const finalHit = reflectionTripwireHit(lesson, 'lesson ' + lesson.id);
        if (finalHit !== undefined) {
          diagnostics.push(
            'reflection tripwire rejected completed lesson ' + lesson.id + ' (' + finalHit.field + '); no lesson emitted'
          );
          continue;
        }
        lessons.push(lesson);
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
        // CORE-9: the diagnostic reports the ACTUAL outcome after the confidence
        // comparison. Emitted before it (the pre-fix position), it named
        // `existing.id` even when the incoming lesson replaced that entry
        // wholesale - pointing auditors at a lesson id that no longer exists in
        // the result - and called it "merged" although no fields are merged.
        // Exactly one of the two survives, so exactly one id is reported.
        const replaced =
          existing !== undefined && (lesson.confidence ?? 0) > (existing.confidence ?? 0);
        if (replaced) {
          deduped[existingIndex] = lesson;
          diagnostics.push(
            'duplicate lesson key ' + key + ' replaced ' + String(existing?.id) + ' with ' + lesson.id
          );
        } else {
          diagnostics.push(
            'duplicate lesson key ' + key + ' kept ' + String(existing?.id) + '; discarded ' + lesson.id
          );
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
