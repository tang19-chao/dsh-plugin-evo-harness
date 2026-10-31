/**
 * Client-Side Governance Polyfill (ARCHITECTURE.md 4.3).
 *
 * Three deterministic guarantees for generic MCP memory backends:
 *  1. pre-write gate      — reject incomplete/poisonous lessons before any network call,
 *                           including embedded script syntax validation;
 *  2. virtual namespaces  — deterministic scope namespaces plus client-side
 *                           filtering for namespace-blind backends;
 *  3. negative firewall   — post-recall whenNotToApply veto and positive/negative
 *                           separation so failure lessons are never injected as
 *                           recommendations (contracts.ts note 6).
 *
 * Every decision is pure and deterministic; no host or network dependency.
 */

import type { MemoryBridgeConfig } from '../config';
import {
  HARNESS_COMPONENT_KEYS,
  type CanonicalLesson,
  type GovernanceViolation,
  type MemoryRecallQuery,
  type MemoryScope,
  type SuppressedLesson
} from '../types/contracts';
import { extractEmbeddedScripts, lessonNamespace } from './lesson-codec';
import {
  deriveNamespace,
  namespaceBelongsToSession,
  namespaceIsBranch,
  namespaceIsGlobal,
  sanitizeNamespaceSegment
} from './namespace';
import type { DriverLessonRecord } from './spi';
import { checkEmbeddedScripts } from './script-syntax';

// ---------------------------------------------------------------------------
// Pre-write deterministic gate
// ---------------------------------------------------------------------------

/** Input of the pre-write gate. */
export interface GovernanceGateInput {
  readonly lesson: CanonicalLesson;
  readonly scope: MemoryScope;
  readonly config: MemoryBridgeConfig;
  readonly namespace: string;
  /** Lesson ids already persisted in this namespace (duplicate detection). */
  readonly existingLessonIds?: ReadonlySet<string>;
}

/** Gate outcome: violations in report order, split into blocking and warning. */
export interface GovernanceGateResult {
  readonly violations: readonly GovernanceViolation[];
  readonly blocking: readonly GovernanceViolation[];
  readonly warnings: readonly GovernanceViolation[];
  readonly accepted: boolean;
}

function violation(
  code: GovernanceViolation['code'],
  message: string,
  severity: GovernanceViolation['severity'],
  field?: string,
  evidence?: string
): GovernanceViolation {
  return {
    code,
    message,
    severity,
    ...(field === undefined ? {} : { field }),
    ...(evidence === undefined ? {} : { evidence })
  };
}

function isEmptyArray(value: readonly unknown[] | undefined): boolean {
  return !Array.isArray(value) || value.length === 0;
}

/**
 * Deterministic pre-write gate. Blocking violations always prevent the backend
 * call; CCG completeness and evidence rules degrade to warnings only when the
 * governance polyfill is explicitly disabled by configuration.
 */
export function validateLessonForWrite(input: GovernanceGateInput): GovernanceGateResult {
  const { lesson, scope, config, namespace } = input;
  const polyfill = config.enableGovernancePolyfill !== false;
  const completeness: GovernanceViolation['severity'] = polyfill ? 'block' : 'warn';
  const violations: GovernanceViolation[] = [];
  const push = (entry: GovernanceViolation): void => {
    violations.push(entry);
  };

  if (lesson === null || typeof lesson !== 'object') {
    push(violation('invalid_lesson', 'Lesson payload must be a CanonicalLesson object.', 'block', 'lesson'));
    return finish(violations);
  }
  if (typeof lesson.id !== 'string' || lesson.id.trim().length === 0) {
    push(violation('invalid_lesson', 'Lesson id must be a non-empty string.', 'block', 'id'));
  }
  if (typeof lesson.title !== 'string' || lesson.title.trim().length === 0) {
    push(violation('invalid_lesson', 'Lesson title (CCG element 1, 功能名) must be non-empty.', 'block', 'title'));
  }
  if (isEmptyArray(lesson.whenToApply)) {
    push(
      violation(
        'missing_when_to_apply',
        'whenToApply (CCG element 2, 生效条件) must contain at least one trigger cue.',
        completeness,
        'whenToApply'
      )
    );
  }
  if (isEmptyArray(lesson.whenNotToApply)) {
    push(
      violation(
        'missing_when_not_to_apply',
        'whenNotToApply (CCG element 6, 克制条款) must contain at least one restraint clause.',
        completeness,
        'whenNotToApply'
      )
    );
  }
  if (isEmptyArray(lesson.subFunctions)) {
    push(
      violation(
        'invalid_sub_functions',
        'subFunctions (CCG element 3) must name at least one harness surface.',
        completeness,
        'subFunctions'
      )
    );
  } else {
    const unknown = lesson.subFunctions.filter(
      (key: string) => !(HARNESS_COMPONENT_KEYS as readonly string[]).includes(key)
    );
    if (unknown.length > 0) {
      push(
        violation(
          'invalid_sub_functions',
          'subFunctions contains unknown harness surfaces: ' + unknown.join(', ') + '.',
          'block',
          'subFunctions'
        )
      );
    }
  }
  const patch = lesson.executionPatch;
  if (
    patch === null ||
    typeof patch !== 'object' ||
    typeof patch.summary !== 'string' ||
    patch.summary.trim().length === 0
  ) {
    push(
      violation(
        'invalid_execution_patch',
        'executionPatch.summary (CCG element 4, 执行动作) must be a non-empty string.',
        'block',
        'executionPatch.summary'
      )
    );
  }
  const evidence = lesson.verificationEvidence;
  const evidenceMissing =
    evidence === null ||
    typeof evidence !== 'object' ||
    typeof evidence.referenceFailure !== 'string' ||
    evidence.referenceFailure.trim().length === 0 ||
    typeof evidence.candidateSuccess !== 'string' ||
    evidence.candidateSuccess.trim().length === 0;
  if (evidenceMissing) {
    const severity: GovernanceViolation['severity'] = config.requireEvidence === false ? 'warn' : completeness;
    push(
      violation(
        'missing_verification_evidence',
        'verificationEvidence (CCG element 5) must carry the reference failure and candidate success.',
        severity,
        'verificationEvidence'
      )
    );
  }

  // Embedded generated scripts/middleware: syntax + path gate (always blocking).
  for (const issue of checkEmbeddedScripts(extractEmbeddedScripts(lesson))) {
    push(violation(issue.code, issue.message, 'block', 'executionPatch.componentDiffs', issue.path));
  }

  violations.push(...scopeViolations(lesson, scope, namespace));

  const metadata = lesson.metadata;
  if (
    lesson.polarity === 'negative' &&
    metadata !== undefined &&
    (metadata as Record<string, unknown>).injectAsRecommendation === true
  ) {
    push(
      violation(
        'negative_polarity_leak',
        'A negative (failure) lesson may never be requested as a recommendation.',
        'block',
        'metadata.injectAsRecommendation'
      )
    );
  }

  if (input.existingLessonIds !== undefined && input.existingLessonIds.has(lesson.id)) {
    push(
      violation(
        'duplicate_lesson',
        'Lesson id ' + lesson.id + ' is already persisted in namespace ' + namespace + '.',
        'warn',
        'id'
      )
    );
  }

  return finish(violations);
}

function finish(violations: GovernanceViolation[]): GovernanceGateResult {
  const blocking = violations.filter((entry) => entry.severity === 'block');
  return {
    violations,
    blocking,
    warnings: violations.filter((entry) => entry.severity === 'warn'),
    accepted: blocking.length === 0
  };
}

function scopeViolations(
  lesson: CanonicalLesson,
  scope: MemoryScope,
  namespace: string
): GovernanceViolation[] {
  const result: GovernanceViolation[] = [];
  if (scope.kind === 'global') {
    if (lesson.visibility !== 'global') {
      result.push(
        violation(
          'scope_violation',
          'Global scope only accepts lessons with visibility "global" (received "' + lesson.visibility + '").',
          'block',
          'visibility'
        )
      );
    }
  } else {
    if (lesson.visibility === 'global') {
      result.push(
        violation(
          'namespace_violation',
          'Branch/session scope cannot accept a globally visible lesson; promote it instead.',
          'block',
          'visibility'
        )
      );
    }
    if (lesson.sessionId !== scope.sessionId) {
      result.push(
        violation(
          'scope_violation',
          'Lesson sessionId "' + lesson.sessionId + '" does not belong to scope session "' + scope.sessionId + '".',
          'block',
          'sessionId'
        )
      );
    }
  }
  if (scope.kind === 'branch' && lesson.branchId !== undefined && lesson.branchId !== scope.branchId) {
    result.push(
      violation(
        'namespace_violation',
        'Lesson branchId "' + lesson.branchId + '" does not match branch scope "' + scope.branchId + '".',
        'block',
        'branchId'
      )
    );
  }
  if (deriveNamespace(scope, namespacePrefixOf(namespace)) !== namespace && scope.kind !== 'global') {
    // Defensive: the caller-supplied namespace must be exactly the derived one.
    result.push(
      violation(
        'namespace_violation',
        'Namespace "' + namespace + '" is not the deterministic namespace of the requested scope.',
        'block',
        'namespace'
      )
    );
  }
  return result;
}

/** The prefix embedded in an already-derived namespace string. */
export function namespacePrefixOf(namespace: string): string {
  const separator = namespace.indexOf(':');
  return separator < 0 ? namespace : namespace.slice(0, separator);
}

// ---------------------------------------------------------------------------
// Namespace isolation
// ---------------------------------------------------------------------------

/** Kind of scope a stored namespace belongs to, from the namespace string alone. */
export type NamespaceTier = 'global' | 'session' | 'branch' | 'foreign';

/** Classify a stored namespace against a prefix. */
export function classifyNamespace(namespace: string, namespacePrefix: string): NamespaceTier {
  if (namespaceIsGlobal(namespace, namespacePrefix)) {
    return 'global';
  }
  const parts = namespace.split(':');
  if (parts[1] === 'session' || parts[1] === 'branch') {
    if (parts[1] === 'branch' && parts.length >= 4) {
      return 'branch';
    }
    if (parts[1] === 'session' && parts.length >= 3) {
      return 'session';
    }
  }
  return 'foreign';
}

/**
 * Whether a stored lesson may be surfaced into the requested scope.
 * Branch A never sees branch B's private lessons; promotion to global is the
 * only cross-branch channel (ARCHITECTURE.md 4.3 item 2).
 */
export function isLessonVisibleInScope(
  lesson: CanonicalLesson,
  recordNamespace: string,
  scope: MemoryScope,
  namespacePrefix: string
): { readonly visible: boolean; readonly detail: string } {
  const record = recordNamespace.length > 0 ? recordNamespace : lessonNamespace(lesson) ?? '';
  const fallbackNamespace = deriveNamespace(scope, namespacePrefix);
  if (record.length > 0) {
    const tier = classifyNamespace(record, namespacePrefix);
    if (lesson.visibility === 'global' || tier === 'global') {
      return {
        visible: lesson.visibility === 'global' || tier === 'global',
        detail: lesson.visibility === 'global' ? 'global lesson' : 'foreign record under the global namespace'
      };
    }
    if (scope.kind === 'global') {
      return { visible: false, detail: 'record ' + record + ' is not global' };
    }
    if (
      scope.kind === 'branch' &&
      namespaceIsBranch(record, namespacePrefix, scope.sessionId, scope.branchId)
    ) {
      return { visible: true, detail: 'branch-private record of this branch' };
    }
    if (!namespaceBelongsToSession(record, namespacePrefix, scope.sessionId)) {
      return { visible: false, detail: 'record ' + record + ' belongs to another session' };
    }
    // Same session, but possibly a sibling branch: only session/global lessons travel.
    if (lesson.visibility === 'branch_private') {
      return { visible: false, detail: 'record ' + record + ' is private to another branch' };
    }
    return { visible: true, detail: 'session-visible record of this session' };
  }
  // Backend gave no namespace: fall back to the lesson's own scope metadata.
  if (lesson.visibility === 'global') {
    return { visible: true, detail: 'global visibility (no namespace reported)' };
  }
  if (scope.kind === 'global') {
    return { visible: false, detail: 'global scope only accepts globally visible lessons' };
  }
  if (lesson.sessionId !== scope.sessionId) {
    return { visible: false, detail: 'lesson sessionId does not match the requested scope' };
  }
  if (lesson.visibility === 'session') {
    return { visible: true, detail: 'session visibility (no namespace reported) for ' + fallbackNamespace };
  }
  if (scope.kind === 'session') {
    return { visible: false, detail: 'branch-private lesson is not visible in session scope' };
  }
  if (lesson.branchId === undefined || lesson.branchId === scope.branchId) {
    return { visible: true, detail: 'branch metadata matched (no namespace reported)' };
  }
  return { visible: false, detail: 'lesson branchId does not match the requested branch' };
}

/** Stamp the deterministic namespace onto a lesson's metadata before writing. */
export function withNamespaceMetadata(
  lesson: CanonicalLesson,
  namespace: string,
  extra: Readonly<Record<string, unknown>> = {}
): CanonicalLesson {
  const metadata: Record<string, unknown> = { ...(lesson.metadata ?? {}) };
  delete metadata.injectAsRecommendation;
  metadata.namespace = namespace;
  for (const [key, value] of Object.entries(extra)) {
    metadata[key] = value;
  }
  return { ...lesson, metadata };
}

// ---------------------------------------------------------------------------
// Post-recall negative firewall
// ---------------------------------------------------------------------------

/** Build the recall fingerprint (task text + signature + context tags). */
export function buildRecallFingerprint(query: MemoryRecallQuery): string {
  const parts: string[] = [];
  if (typeof query.text === 'string' && query.text.trim().length > 0) {
    parts.push(query.text.trim());
  }
  if (typeof query.taskSignature === 'string' && query.taskSignature.trim().length > 0) {
    parts.push(query.taskSignature.trim());
  }
  for (const tag of query.contextTags ?? []) {
    if (typeof tag === 'string' && tag.trim().length > 0) {
      parts.push(tag.trim());
    }
  }
  return parts.join(' ');
}

const CJK_RUN = /[\u4e00-\u9fff]{2,}/g;
const LATIN_TOKEN = /[a-z0-9_]{2,}/g;

/** Two-character shingles of a CJK run (CJK has no word delimiters). */
function cjkShingles(run: string): string[] {
  if (run.length <= 2) {
    return [run];
  }
  const shingles: string[] = [];
  for (let index = 0; index + 2 <= run.length; index += 1) {
    shingles.push(run.slice(index, index + 2));
  }
  return shingles;
}

/** Tokenize free text into latin words plus CJK runs and CJK bigrams. */
export function tokenizeContext(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = typeof text === 'string' ? text.toLowerCase() : '';
  for (const token of lower.match(LATIN_TOKEN) ?? []) {
    tokens.add(token);
  }
  for (const run of text.match(CJK_RUN) ?? []) {
    tokens.add(run);
    for (const shingle of cjkShingles(run)) {
      tokens.add(shingle);
    }
  }
  return tokens;
}

/**
 * Whether one whenNotToApply clause matches the current task context.
 *
 * CJK clauses match in two deterministic steps, mirroring the latin-token rule:
 *   1. exact full-run containment of any clause run vetoes immediately;
 *   2. otherwise at least half of the clause's shingles (pooled over all runs)
 *      must appear in the context — a single incidental common bigram like
 *      "任务" must not veto "不适用于简单表格任务";
 * a clause that produces exactly one shingle still matches when that shingle is
 * present (step 1 covers the 2-character run case).
 *
 * Latin clauses match when at least half of their significant tokens appear in
 * the context (a single-token clause must match exactly). Deterministic for a
 * given clause/context pair; any matching clause still vetoes the recall.
 */
export function clauseMatchesContext(clause: string, contextTokens: ReadonlySet<string>): boolean {
  if (typeof clause !== 'string' || clause.trim().length === 0) {
    return false;
  }
  const cjkRuns = clause.match(CJK_RUN) ?? [];
  if (cjkRuns.length > 0) {
    // Step 1: the clause's own run appears verbatim in the context.
    for (const run of cjkRuns) {
      if (contextTokens.has(run)) {
        return true;
      }
    }
    // Step 2: aggregate shingle coverage must reach the latin-token threshold.
    const shingles: string[] = [];
    for (const run of cjkRuns) {
      for (const shingle of cjkShingles(run)) {
        shingles.push(shingle);
      }
    }
    if (shingles.length === 0) {
      return false;
    }
    let shingleHits = 0;
    for (const shingle of shingles) {
      if (contextTokens.has(shingle)) {
        shingleHits += 1;
      }
    }
    return shingleHits / shingles.length >= 0.5;
  }
  const tokens = (clause.toLowerCase().match(LATIN_TOKEN) ?? []).filter((token) => token.length >= 2);
  if (tokens.length === 0) {
    return false;
  }
  let hits = 0;
  for (const token of tokens) {
    if (contextTokens.has(token)) {
      hits += 1;
    }
  }
  if (tokens.length === 1) {
    return hits === 1;
  }
  return hits / tokens.length >= 0.5;
}

/** Every clause of one channel matched by the query context, in declaration order. */
function matchingClauses(clauses: readonly string[] | undefined, context: ReadonlySet<string>): string[] {
  const matches: string[] = [];
  for (const clause of clauses ?? []) {
    if (clauseMatchesContext(clause, context)) {
      matches.push(clause);
    }
  }
  return matches;
}

/**
 * P4-2 (positive recall conditions): both channels are matched by the SAME
 * deterministic CJK/latin rule above, over one tokenized context.
 *
 * `whenToApply` hits are observations — the cue that says this lesson is
 * relevant now. `whenNotToApply` hits are vetoes — the negative firewall drops
 * the lesson. Sharing the matcher is the property guaranteed here: one clause
 * moved between the two arrays matches (or does not) identically.
 */
export interface LessonConditionMatches {
  readonly whenToApply: readonly string[];
  readonly whenNotToApply: readonly string[];
}

export function matchLessonConditions(
  lesson: CanonicalLesson,
  query: MemoryRecallQuery
): LessonConditionMatches {
  const context = tokenizeContext(buildRecallFingerprint(query));
  return {
    whenToApply: matchingClauses(lesson.whenToApply, context),
    whenNotToApply: matchingClauses(lesson.whenNotToApply, context)
  };
}

/** The first whenNotToApply clause matched by the query context, if any. */
export function matchedRestraintClause(lesson: CanonicalLesson, query: MemoryRecallQuery): string | undefined {
  const context = tokenizeContext(buildRecallFingerprint(query));
  if (context.size === 0) {
    return undefined;
  }
  return matchingClauses(lesson.whenNotToApply, context)[0];
}

export interface FirewallInput {
  readonly records: readonly DriverLessonRecord[];
  readonly query: MemoryRecallQuery;
  readonly scope: MemoryScope;
  readonly config: MemoryBridgeConfig;
  readonly minConfidence: number;
}

export interface FirewallOutput {
  readonly lessons: readonly CanonicalLesson[];
  readonly positiveLessons: readonly CanonicalLesson[];
  readonly negativeLessons: readonly CanonicalLesson[];
  readonly suppressedLessons: readonly SuppressedLesson[];
  readonly confidence: number;
  readonly diagnostics: readonly string[];
}

/**
 * Post-recall cleaning: scope filter, whenNotToApply veto, confidence floor and
 * positive/negative separation. lessons === positiveLessons + negativeLessons.
 */
export function applyPostRecallFirewall(input: FirewallInput): FirewallOutput {
  const { records, query, scope, config, minConfidence } = input;
  const positiveLessons: CanonicalLesson[] = [];
  const negativeLessons: CanonicalLesson[] = [];
  const suppressedLessons: SuppressedLesson[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  const includeNegative = query.includeNegative !== false;
  const firewall = config.enableNegativeFirewall !== false;
  if (!firewall) {
    diagnostics.push('negative firewall disabled by configuration: whenNotToApply clauses are not vetoed');
  }

  for (const record of records) {
    const lesson = record.lesson;
    if (lesson === null || typeof lesson !== 'object' || typeof lesson.id !== 'string') {
      continue;
    }
    const visibility = isLessonVisibleInScope(lesson, record.namespace, scope, config.namespacePrefix);
    if (!visibility.visible) {
      suppressedLessons.push({
        lessonId: lesson.id,
        title: lesson.title,
        reason: 'scope_mismatch',
        detail: visibility.detail
      });
      continue;
    }
    if (firewall) {
      const clause = matchedRestraintClause(lesson, query);
      if (clause !== undefined) {
        suppressedLessons.push({
          lessonId: lesson.id,
          title: lesson.title,
          reason: 'when_not_to_apply',
          detail: 'context matched restraint clause "' + clause + '"'
        });
        continue;
      }
    }
    const confidence = typeof lesson.confidence === 'number' ? lesson.confidence : 0.5;
    if (confidence < minConfidence) {
      suppressedLessons.push({
        lessonId: lesson.id,
        title: lesson.title,
        reason: 'low_confidence',
        detail: 'confidence ' + confidence + ' < minConfidence ' + minConfidence
      });
      continue;
    }
    if (seen.has(lesson.id)) {
      continue;
    }
    seen.add(lesson.id);
    if (lesson.polarity === 'negative') {
      if (!includeNegative) {
        suppressedLessons.push({
          lessonId: lesson.id,
          title: lesson.title,
          reason: 'negative_polarity_filtered',
          detail: 'includeNegative=false: failure lesson withheld from recommendations'
        });
        continue;
      }
      negativeLessons.push(lesson);
      continue;
    }
    positiveLessons.push(lesson);
  }

  const confidence =
    positiveLessons.length === 0
      ? 0
      : clamp01(
          positiveLessons.reduce(
            (total, lesson) => total + (typeof lesson.confidence === 'number' ? lesson.confidence : 0.5),
            0
          ) / positiveLessons.length
        );

  return {
    lessons: [...positiveLessons, ...negativeLessons],
    positiveLessons,
    negativeLessons,
    suppressedLessons,
    confidence,
    diagnostics
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** Sanitize helper re-exported for adapter authors. */
export const sanitizeSegment = sanitizeNamespaceSegment;
