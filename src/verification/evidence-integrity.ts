/**
 * rev8 evidence-integrity trio (harness2 upstream #67 / #72 / #118 / #175).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Three independent upstream fixes share one theme: an artifact that LOOKS like
 * evidence must be checked before any model reads it, and a failure in ONE
 * artifact channel must never destroy or impersonate another.
 *
 *   #67  the trajectory render and the deliverable render fail INDEPENDENTLY;
 *        a deliverable failure must not overwrite the trajectory and a
 *        trajectory failure must not blank the deliverable.
 *   #72  a missing/unparseable-trajectory SENTINEL string is not a render: it
 *        is rejected as evidence wherever it appears.
 *   #118 a task's own answer-key TEXT (grading criteria) that reaches evidence
 *        via any route is contamination: the evidence is withheld, replaced by
 *        a neutral note, and no message ever carries the matched words.
 *   #175 a component path that collides with an answer-key path is rejected
 *        BEFORE the probe rolls out, so it can never be served as evidence.
 *
 * TRUST BOUNDARY (same discipline as C2a)
 * ---------------------------------------
 * The scan inputs (answer-key criteria, visible text, forbidden path segments)
 * are HOST-owned. They are supplied by the assembly, never read from
 * `result.metadata` — a branch executor cannot declare its own evidence clean
 * (see tests/unit/cordis-seams/trajectory-collector-c2a.test.ts). The persisted
 * mark is a structural fact about what was scanned, not a signature: a reader
 * can re-check it, an attacker who rewrites both the mark and the content on
 * disk is outside this module's threat model (same honesty note as
 * verified-tree-gate.ts).
 *
 * NO LEAKED WORDS: every finding reports criterion ids and counts only. The
 * matched text itself never enters a finding, a diagnostic, a failure signal
 * or an error message, because stage errors are themselves served to later
 * stages as decision notes (upstream #118's own rationale).
 *
 * Pure and dependency-light: only contracts types and node:crypto.
 */
import { createHash } from 'node:crypto';
import type { EightSurfacePatch, ProbeTrajectory } from '../types/contracts';

/** Mark identity; bumping it invalidates every previously persisted mark. */
export const EVIDENCE_INTEGRITY_VERSION = 'rev8-evidence-integrity-v1' as const;

/** The open `ProbeTrajectory.metadata` key the mark rides under. */
export const EVIDENCE_INTEGRITY_METADATA_KEY = 'evidenceIntegrity' as const;

// ---------------------------------------------------------------------------
// #72: missing/unparseable-trajectory sentinels
// ---------------------------------------------------------------------------

/**
 * The sentinel prefixes a broken renderer produces instead of a trajectory
 * (upstream #72: opencode/codex render_events failures, adapter read failures).
 * An EMPTY (or whitespace-only) render is the same failure with no message.
 */
export const MISSING_TRAJECTORY_PREFIXES = [
  '(no trajectory',
  '(no parseable events in trajectory)',
  '(failed to read trajectory:',
  '(trajectory unavailable:'
] as const;

/** True when `text` is empty or one of the missing-trajectory sentinels. */
export function isMissingTrajectorySentinel(text: string | undefined): boolean {
  const stripped = (text ?? '').trim();
  if (stripped.length === 0) {
    return true;
  }
  return MISSING_TRAJECTORY_PREFIXES.some((prefix) => stripped.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// #118: answer-key text matching (verbatim 10-word shingles)
// ---------------------------------------------------------------------------

/** A 10-word verbatim passage is the smallest unit that survives formatting. */
export const ANSWER_KEY_SHINGLE_WORDS = 10;
/** Distinct key passages a text must share before it counts as carrying the key. */
export const ANSWER_KEY_MIN_SHARED = 3;
/** …drawn from at least this fraction of the task's criteria. */
export const ANSWER_KEY_MIN_FRACTION = 0.5;

const ESCAPE_RE = /\\(?:n|r|t|u[0-9a-fA-F]{4})/g;
const TOKEN_RE = /[a-z0-9]+(?:[.,'][a-z0-9]+)*/g;
/** Quoted passages a rubric lifts from the task's own material are dropped. */
const QUOTED_RE = /["\u201c\u201d]([^"\u201c\u201d\n]{1,600})["\u201c\u201d]/g;

function unescapeMatch(match: string): string {
  if (match.charAt(1) === 'u') {
    const code = Number.parseInt(match.slice(2), 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : ' ';
  }
  return ' ';
}

/**
 * Lower-cased word tokens and their offsets. JSON escapes are undone first, so
 * an answer key printed inside a JSON tool result still lines up word for word
 * with the criterion text.
 */
export function evidenceWords(text: string): { readonly tokens: readonly string[]; readonly starts: readonly number[] } {
  const plain = String(text ?? '').replace(ESCAPE_RE, unescapeMatch).toLowerCase();
  const tokens: string[] = [];
  const starts: number[] = [];
  for (const match of plain.matchAll(TOKEN_RE)) {
    tokens.push(match[0]);
    starts.push(match.index ?? 0);
  }
  return { tokens, starts };
}

function shingleKey(tokens: readonly string[], offset: number): string {
  return tokens.slice(offset, offset + ANSWER_KEY_SHINGLE_WORDS).join('\u0000');
}

/** The set of 10-word shingles of a text. */
export function evidenceShingles(text: string): ReadonlySet<string> {
  const { tokens } = evidenceWords(text);
  const shingles = new Set<string>();
  for (let offset = 0; offset + ANSWER_KEY_SHINGLE_WORDS <= tokens.length; offset += 1) {
    shingles.add(shingleKey(tokens, offset));
  }
  return shingles;
}

/** One grading passage: a stable id (reported on hits) and its text. */
export interface AnswerKeyCriterion {
  readonly id: string;
  readonly text: string;
}

/** A shingle -> criterion-id index; empty when nothing survived subtraction. */
export type AnswerKeyIndex = ReadonlyMap<string, string>;

/**
 * Build the key: criterion shingles minus quoted passages, minus everything the
 * agent was legitimately shown (`visibleText` — the task prompt, its source
 * files). A criterion id owns a shingle on a first-come basis.
 */
export function buildAnswerKeyIndex(
  criteria: readonly AnswerKeyCriterion[],
  visibleText: readonly string[] = []
): AnswerKeyIndex {
  const index = new Map<string, string>();
  for (const criterion of criteria) {
    if (criterion === undefined || criterion === null) {
      continue;
    }
    if (typeof criterion.id !== 'string' || criterion.id.length === 0) {
      continue;
    }
    if (typeof criterion.text !== 'string' || criterion.text.length === 0) {
      continue;
    }
    const unquoted = criterion.text.replace(QUOTED_RE, ' ');
    for (const shingle of evidenceShingles(unquoted)) {
      if (!index.has(shingle)) {
        index.set(shingle, criterion.id);
      }
    }
  }
  for (const text of visibleText) {
    for (const shingle of sharedShingles(index, text).keys()) {
      index.delete(shingle);
    }
    if (index.size === 0) {
      break;
    }
  }
  return index;
}

/** Distinct key shingles present in `text`, each with its first offset. */
function sharedShingles(
  index: AnswerKeyIndex,
  text: string
): ReadonlyMap<string, number> {
  const found = new Map<string, number>();
  if (index.size === 0) {
    return found;
  }
  const { tokens, starts } = evidenceWords(text);
  const firstTokens = new Set<string>();
  for (const shingle of index.keys()) {
    firstTokens.add(shingle.split('\u0000')[0] ?? '');
  }
  for (let offset = 0; offset + ANSWER_KEY_SHINGLE_WORDS <= tokens.length; offset += 1) {
    if (!firstTokens.has(tokens[offset] ?? '')) {
      continue;
    }
    const shingle = shingleKey(tokens, offset);
    if (index.has(shingle) && !found.has(shingle)) {
      found.set(shingle, starts[offset] ?? 0);
    }
  }
  return found;
}

/**
 * WHERE a text carries answer-key words. Never the words themselves: the hit
 * feeds findings, diagnostics and error messages, and those must not become a
 * second route for the key.
 */
export interface AnswerKeyScanHit {
  readonly sharedPassages: number;
  readonly matchedCriteria: number;
  readonly totalCriteria: number;
  readonly firstCriterionId: string;
}

/**
 * A hit when `text` shares ≥3 key passages drawn from ≥half the criteria.
 *
 * The breadth test is what separates a fetched answer key, which carries every
 * criterion, from a source document that a few criteria quote unmarked.
 */
export function scanAnswerKeyText(text: string, index: AnswerKeyIndex): AnswerKeyScanHit | undefined {
  if (index.size === 0) {
    return undefined;
  }
  const found = sharedShingles(index, text);
  if (found.size < ANSWER_KEY_MIN_SHARED) {
    return undefined;
  }
  const totalCriteria = new Set(index.values()).size;
  const matched = new Set<string>();
  for (const shingle of found.keys()) {
    const id = index.get(shingle);
    if (id !== undefined) {
      matched.add(id);
    }
  }
  const required = Math.max(1, Math.ceil(ANSWER_KEY_MIN_FRACTION * totalCriteria));
  if (matched.size < required) {
    return undefined;
  }
  let firstShingle: string | undefined;
  let firstOffset = Number.POSITIVE_INFINITY;
  for (const [shingle, offset] of found) {
    if (offset < firstOffset) {
      firstOffset = offset;
      firstShingle = shingle;
    }
  }
  return {
    sharedPassages: found.size,
    matchedCriteria: matched.size,
    totalCriteria,
    firstCriterionId: firstShingle === undefined ? '' : (index.get(firstShingle) ?? '')
  };
}

// ---------------------------------------------------------------------------
// #175: answer-key path collisions in a harness patch
// ---------------------------------------------------------------------------

/**
 * The component paths a patch would create: `skills/<name>/SKILL.md`,
 * `sub_agents/<name>/AGENT.md` and each script's own path. Defensive reading —
 * malformed payloads contribute nothing rather than throwing.
 */
export function patchEvidencePaths(patch: EightSurfacePatch): readonly string[] {
  const paths: string[] = [];
  const edits: unknown = (patch as { edits?: unknown } | undefined)?.edits;
  if (edits === undefined || edits === null || typeof edits !== 'object') {
    return paths;
  }
  const record = edits as Record<string, unknown>;
  const skills = record['skills'];
  if (isRecord(skills) && Array.isArray(skills['skills'])) {
    for (const skill of skills['skills']) {
      if (isRecord(skill) && typeof skill['name'] === 'string' && skill['name'].length > 0) {
        paths.push('skills/' + skill['name'] + '/SKILL.md');
      }
    }
  }
  const subagents = record['subagents'];
  if (isRecord(subagents) && Array.isArray(subagents['agents'])) {
    for (const agent of subagents['agents']) {
      if (isRecord(agent) && typeof agent['name'] === 'string' && agent['name'].length > 0) {
        paths.push('sub_agents/' + agent['name'] + '/AGENT.md');
      }
    }
  }
  const scripts = record['scripts'];
  if (isRecord(scripts) && Array.isArray(scripts['scripts'])) {
    for (const script of scripts['scripts']) {
      if (isRecord(script) && typeof script['path'] === 'string' && script['path'].length > 0) {
        // Posix-normalized: a path is a path, on any host.
        paths.push(String(script['path']).replace(/\\/g, '/'));
      }
    }
  }
  return paths;
}

/**
 * Paths colliding with a forbidden answer-key segment, in input order.
 *
 * Matching is EXACT on one path segment (posix-normalized), mirroring upstream
 * #175's `tests/**` semantics under any directory: `skills/tests/SKILL.md`
 * collides, `skills/run_tests/SKILL.md` and `scripts/tests.py` do not.
 */
export function findAnswerKeyPathCollisions(
  paths: readonly string[],
  forbiddenSegments: readonly string[]
): readonly string[] {
  const forbidden = new Set(forbiddenSegments);
  if (forbidden.size === 0) {
    return [];
  }
  const hits: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.length === 0) {
      continue;
    }
    const normalized = raw.replace(/\\/g, '/');
    for (const segment of normalized.split('/')) {
      if (forbidden.has(segment)) {
        hits.push(normalized);
        break;
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// the persisted mark
// ---------------------------------------------------------------------------

export type EvidenceIntegrityFaultKind =
  | 'missing-trajectory-sentinel'
  | 'answer-key-text'
  | 'answer-key-path';

/** One finding. Counts and ids only — never the matched words. */
export interface EvidenceIntegrityFinding {
  readonly kind: EvidenceIntegrityFaultKind;
  /** Where the finding fired: 'deliverable', 'steps[i]', 'tool-errors[i]', 'patch'. */
  readonly location: string;
  readonly criterionId?: string;
  readonly sharedPassages?: number;
  readonly matchedCriteria?: number;
  readonly totalCriteria?: number;
  readonly collidingPath?: string;
}

/**
 * The scan verdict persisted on the trajectory metadata. `withheld: true`
 * means the raw content must not reach any model; the findings say why.
 */
export interface EvidenceIntegrityMark {
  readonly version: typeof EVIDENCE_INTEGRITY_VERSION;
  readonly contaminated: boolean;
  readonly withheld: boolean;
  readonly findings: readonly EvidenceIntegrityFinding[];
  /**
   * Findings elided by `EVIDENCE_INTEGRITY_MAX_FINDINGS` (absent when zero).
   * Present so an audit record can never claim "1 finding" when the mark
   * actually represents thousands; `findings` stays a bounded SAMPLE.
   */
  readonly droppedFindings?: number;
  readonly taskId?: string;
}

// ---------------------------------------------------------------------------
// bounded findings (rev8 audit: unbounded cardinality on every route)
//
// WHY THIS EXISTS
//   `findings` is the only variable-length part of a mark, and each of its
//   three text fields is individually capped at 500 characters while the LIST
//   was not capped anywhere. A branch can drive the cardinality directly: one
//   finding per step surface in `scanTrajectoryEvidenceIntegrity`, one per
//   colliding path in `scanPatchEvidenceIntegrity`, and an arbitrary list on
//   the carried channel (`metadata.trajectory.evidenceIntegrity`), which is
//   re-persisted verbatim by `quarantineTrajectory`. Measured on this tree
//   before the cap: 20,000 carried findings accepted (2.57 MB mark), a single
//   run's tree-pool record at 31 MB, and a 60,000-finding mark read back on
//   restart. The persistence layer's only trigger was RECORD count (a byte
//   trigger now exists at src/persistence/tree-pool.store.ts), so record size
//   is the lever this cap pulls.
//
// WHAT THE CAP GUARANTEES
//   * A mark carries at most MAX findings, whatever any producer was handed, and
//     each text field is bounded too: worst case is ~104 KB of ASCII (~293 KB of
//     all-CJK, measured), typically ~8 KB). Never tens of megabytes.
//   * The cap never hides WHICH KINDS fired: the first finding of every kind is
//     always retained, so `quarantineTrajectory`'s answer-key-text /
//     answer-key-path / sentinel classification (and therefore the diagnostics
//     and repairability rules) is unchanged by truncation.
//   * Nothing is silently dropped: the elided count rides along as
//     `droppedFindings`.
//   * No input can crash a consumer: an unusable entry (null, a string, a
//     foreign kind) is counted as elided instead of entering the list.
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on the findings ONE mark carries. See the block above.
 *
 * A count cap alone is NOT a byte bound: the second defect found on the same
 * route was that each finding's text fields were unbounded on the host-owned
 * scan paths (a 1 MB component path became a 1,000,163 B finding, and 64 such
 * findings read back from disk became a 25.6 MB mark — the count cap was
 * satisfied and the record was still huge). So a finding is capped in BOTH
 * dimensions: at most EVIDENCE_INTEGRITY_MAX_FINDINGS entries, each text field
 * at most EVIDENCE_INTEGRITY_MAX_TEXT characters.
 *
 * The bound that follows, stated honestly: text is counted in CHARACTERS, and
 * a character may encode as up to 3 UTF-8 bytes (4 for an emoji outside the
 * BMP), so the ceiling is 64 x 3 x 500 x 3 bytes ~= 288 KB for all-CJK content
 * (measured worst case: 293,017 B) and ~104 KB for ASCII. Both are a bounded
 * record; neither is tens of megabytes.
 */
export const EVIDENCE_INTEGRITY_MAX_FINDINGS = 64;

/**
 * Longest text ONE finding field may carry, in characters.
 *
 * Applied at the single choke point every producer funnels through
 * (`createEvidenceIntegrityFindingSet().offer`), so no route — host scan, patch
 * scan, carried channel, merge, tree aggregation, persisted legacy record —
 * can produce a wider field.
 */
export const EVIDENCE_INTEGRITY_MAX_TEXT = 500;

/** Streaming, bounded accumulator: findings are sampled as they are produced. */
export interface EvidenceIntegrityFindingSet {
  /**
   * Keep `finding` if the budget allows, else count it as elided. Never throws:
   * a malformed entry (null, a string, a foreign kind, a missing location) is
   * counted as elided instead of entering the mark, so a persisted or
   * branch-supplied list can never crash a consumer.
   */
  offer(finding: EvidenceIntegrityFinding): void;
  readonly findings: readonly EvidenceIntegrityFinding[];
  readonly droppedFindings: number;
}

const FAULT_KINDS: ReadonlySet<string> = new Set<EvidenceIntegrityFaultKind>([
  'missing-trajectory-sentinel',
  'answer-key-text',
  'answer-key-path'
]);

/** Truncate one text field to the byte ceiling, or `undefined` when unusable. */
function boundedText(value: unknown, strict: boolean): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value.length > EVIDENCE_INTEGRITY_MAX_TEXT) {
    // STRICT (the branch-controlled carried channel): an over-long field means
    // the claim is malformed, and a malformed claim must void the whole mark —
    // fail closed, exactly as before the cap existed.
    if (strict) {
      return undefined;
    }
    // BOUNDED (host-owned producers and marks read back from disk): the fault
    // is real and must stay reportable, so the value is cut instead of dropped.
    // The ellipsis keeps it obvious to a reader that the value was truncated.
    return value.slice(0, EVIDENCE_INTEGRITY_MAX_TEXT - 1) + '…';
  }
  return value;
}

/** A count field: finite, integral and non-negative, else dropped. */
function boundedCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * Rebuild ONE finding from known fields, bounding every text field.
 * `undefined` means the entry is not a usable finding at all.
 *
 * Rebuilt rather than mutated: unknown keys, prototype-carried values and
 * getters do not survive, so a persisted or branch-supplied object cannot smuggle
 * extra payload into a mark.
 *
 * `strict` selects the direction for an over-long text field: the carried
 * channel (branch-controlled) rejects it, every host-owned producer truncates
 * it. Both directions bound the BYTES; they differ only in whether a single bad
 * field forfeits the whole claim.
 */
export function boundEvidenceIntegrityFinding(
  finding: unknown,
  strict = false
): EvidenceIntegrityFinding | undefined {
  if (!isRecord(finding)) {
    return undefined;
  }
  const kind = finding['kind'];
  if (typeof kind !== 'string' || !FAULT_KINDS.has(kind)) {
    return undefined;
  }
  const location = boundedText(finding['location'], strict);
  if (location === undefined || location.length === 0) {
    return undefined;
  }
  const criterionId = boundedText(finding['criterionId'], strict);
  const collidingPath = boundedText(finding['collidingPath'], strict);
  const sharedPassages = boundedCount(finding['sharedPassages']);
  const matchedCriteria = boundedCount(finding['matchedCriteria']);
  const totalCriteria = boundedCount(finding['totalCriteria']);
  return {
    kind: kind as EvidenceIntegrityFaultKind,
    location,
    ...(criterionId === undefined || criterionId.length === 0 ? {} : { criterionId }),
    ...(sharedPassages === undefined ? {} : { sharedPassages }),
    ...(matchedCriteria === undefined ? {} : { matchedCriteria }),
    ...(totalCriteria === undefined ? {} : { totalCriteria }),
    ...(collidingPath === undefined || collidingPath.length === 0 ? {} : { collidingPath })
  };
}

/**
 * Create a bounded finding set.
 *
 * KIND COVERAGE: the first finding of a kind not yet represented is always
 * kept. While the list is under the cap that costs nothing; once the cap is
 * reached a new kind EVICTS the oldest finding of the most-represented other
 * kind (so the total stays exactly at the cap and the evicted one is counted as
 * elided). That is what makes coverage order-independent: an attacker cannot
 * bury `answer-key-text` under thousands of sentinel findings, and a
 * single-kind flood still uses the whole budget instead of leaving reserved
 * slots idle.
 */
export function createEvidenceIntegrityFindingSet(): EvidenceIntegrityFindingSet {
  const findings: EvidenceIntegrityFinding[] = [];
  const kinds = new Set<EvidenceIntegrityFaultKind>();
  const perKind = new Map<EvidenceIntegrityFaultKind, number>();
  let dropped = 0;
  const record = (finding: EvidenceIntegrityFinding): void => {
    findings.push(finding);
    kinds.add(finding.kind);
    perKind.set(finding.kind, (perKind.get(finding.kind) ?? 0) + 1);
  };
  /** Drop ONE finding of the kind with the most entries; never an only child. */
  const evict = (): void => {
    let victimKind: EvidenceIntegrityFaultKind | undefined;
    let victimCount = 1;
    for (const [kind, count] of perKind) {
      if (count > victimCount) {
        victimCount = count;
        victimKind = kind;
      }
    }
    if (victimKind === undefined) {
      return;
    }
    const index = findings.findIndex((entry) => entry.kind === victimKind);
    if (index < 0) {
      return;
    }
    findings.splice(index, 1);
    perKind.set(victimKind, victimCount - 1);
    dropped += 1;
  };
  return {
    offer(finding: EvidenceIntegrityFinding): void {
      // THE CHOKE POINT: every producer — and every consumer that re-offers a
      // list read back from disk — passes through here, so the per-field byte
      // ceiling is enforced once, for all of them. A malformed entry is
      // COUNTED, not thrown on and not accepted: `null`/strings/foreign kinds
      // used to reach the mark and crash `treeEvidenceIntegrityMark` and
      // `quarantineTrajectory` on `.kind`.
      const normalized = boundEvidenceIntegrityFinding(finding);
      if (normalized === undefined) {
        dropped += 1;
        return;
      }
      if (!kinds.has(normalized.kind)) {
        if (findings.length >= EVIDENCE_INTEGRITY_MAX_FINDINGS) {
          evict();
        }
        record(normalized);
        return;
      }
      if (findings.length < EVIDENCE_INTEGRITY_MAX_FINDINGS) {
        record(normalized);
        return;
      }
      dropped += 1;
    },
    get findings(): readonly EvidenceIntegrityFinding[] {
      return [...findings];
    },
    get droppedFindings(): number {
      return dropped;
    }
  };
}

/**
 * Apply the SAME bound to an already-materialised list (a persisted mark read
 * back from disk, a union, or a projection). Kind coverage and the elided
 * count are preserved exactly as the streaming set computes them, and any
 * count the input already carried is added to what this pass elides, so a
 * bounded mark can never under-report through a second pass.
 */
export function boundEvidenceIntegrityFindings(
  findings: readonly EvidenceIntegrityFinding[],
  alreadyDropped = 0
): {
  readonly findings: readonly EvidenceIntegrityFinding[];
  readonly droppedFindings?: number;
} {
  const set = createEvidenceIntegrityFindingSet();
  for (const finding of findings) {
    set.offer(finding);
  }
  const dropped = set.droppedFindings + (Number.isFinite(alreadyDropped) && alreadyDropped > 0 ? alreadyDropped : 0);
  const kept = set.findings;
  return dropped === 0 ? { findings: kept } : { findings: kept, droppedFindings: dropped };
}

/**
 * The `findings`/`droppedFindings` fields of a mark built from `set`. The
 * count field is omitted when nothing was elided, so a small mark keeps its
 * pre-cap byte shape.
 */
function findingsOf(set: EvidenceIntegrityFindingSet): {
  readonly findings: readonly EvidenceIntegrityFinding[];
  readonly droppedFindings?: number;
} {
  const findings = set.findings;
  const dropped = set.droppedFindings;
  return dropped === 0 ? { findings } : { findings, droppedFindings: dropped };
}

/** Host-owned scan inputs. Never derivable from branch-supplied metadata. */
export interface EvidenceIntegrityPolicy {
  readonly taskId?: string;
  /** #118: the task's own grading passages and what the agent was shown. */
  readonly answerKey?: {
    readonly criteria: readonly AnswerKeyCriterion[];
    readonly visibleText?: readonly string[];
  };
  /** #175: path segments whose appearance in a patch component path is a collision. */
  readonly forbiddenPathSegments?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Scan ONE trajectory's content for sentinel and answer-key contamination.
 * Returns `undefined` when the trajectory is clean (or no policy applies).
 */
export function scanTrajectoryEvidenceIntegrity(
  trajectory: Pick<ProbeTrajectory, 'steps' | 'toolErrors' | 'deliverable'>,
  policy: EvidenceIntegrityPolicy
): EvidenceIntegrityMark | undefined {
  // BOUNDED (rev8 audit): the finding list is capped as it is produced, so a
  // branch-returned `steps`/`toolErrors` array of any length yields a mark of
  // at most EVIDENCE_INTEGRITY_MAX_FINDINGS entries. Every surface is still
  // scanned (the verdict must reflect all of them; only STORAGE is bounded),
  // and each surface's text is built and released one at a time instead of
  // being materialised into a parallel array.
  const findings = createEvidenceIntegrityFindingSet();

  // #72: a sentinel deliverable is not a produced artifact.
  const deliverable = trajectory.deliverable;
  if (
    deliverable !== undefined &&
    deliverable !== null &&
    typeof deliverable.content === 'string' &&
    isMissingTrajectorySentinel(deliverable.content)
  ) {
    findings.offer({ kind: 'missing-trajectory-sentinel', location: 'deliverable' });
  }

  // #118: answer-key text across the evidence content.
  if (policy.answerKey !== undefined) {
    const index = buildAnswerKeyIndex(
      policy.answerKey.criteria,
      policy.answerKey.visibleText ?? []
    );
    if (index.size > 0) {
      const scanSurface = (location: string, text: string): void => {
        const hit = scanAnswerKeyText(text, index);
        if (hit !== undefined) {
          findings.offer({
            kind: 'answer-key-text',
            location,
            criterionId: hit.firstCriterionId,
            sharedPassages: hit.sharedPassages,
            matchedCriteria: hit.matchedCriteria,
            totalCriteria: hit.totalCriteria
          });
        }
      };
      scanSurface(
        'deliverable',
        safeText(deliverable === undefined || deliverable === null ? '' : deliverable.content)
      );
      const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
      for (const step of steps) {
        if (step === undefined || step === null || typeof step !== 'object') {
          continue;
        }
        scanSurface(
          'steps[' + String((step as { index?: unknown }).index ?? '?') + ']',
          safeText((step as { text?: unknown }).text) +
            '\n' +
            safeText((step as { toolArguments?: unknown }).toolArguments) +
            '\n' +
            safeText((step as { toolResult?: unknown }).toolResult) +
            '\n' +
            safeText((step as { error?: unknown }).error)
        );
      }
      const toolErrors = Array.isArray(trajectory.toolErrors) ? trajectory.toolErrors : [];
      for (const [position, toolError] of toolErrors.entries()) {
        if (toolError === undefined || toolError === null || typeof toolError !== 'object') {
          continue;
        }
        scanSurface(
          'tool-errors[' + String(position) + ']',
          safeText((toolError as { message?: unknown }).message)
        );
      }
    }
  }

  const kept = findings.findings;
  if (kept.length === 0) {
    return undefined;
  }
  return {
    version: EVIDENCE_INTEGRITY_VERSION,
    contaminated: true,
    withheld: true,
    ...findingsOf(findings),
    ...(policy.taskId === undefined ? {} : { taskId: policy.taskId })
  };
}

/**
 * #175 pre-rollout check: does this PATCH create a component at an
 * answer-key-colliding path? Returns the findings, or `undefined` when clean
 * (or the policy names no forbidden segments).
 */
export function scanPatchEvidenceIntegrity(
  patch: EightSurfacePatch,
  policy: EvidenceIntegrityPolicy
): EvidenceIntegrityMark | undefined {
  const segments = policy.forbiddenPathSegments;
  if (segments === undefined || segments.length === 0) {
    return undefined;
  }
  const collisions = findAnswerKeyPathCollisions(patchEvidencePaths(patch), segments);
  if (collisions.length === 0) {
    return undefined;
  }
  // BOUNDED (rev8 audit): a patch may declare any number of components; the
  // persisted mark keeps at most EVIDENCE_INTEGRITY_MAX_FINDINGS of them and
  // reports how many were elided.
  const findings = createEvidenceIntegrityFindingSet();
  for (const collidingPath of collisions) {
    findings.offer({ kind: 'answer-key-path', location: 'patch', collidingPath });
  }
  return {
    version: EVIDENCE_INTEGRITY_VERSION,
    contaminated: true,
    withheld: true,
    ...findingsOf(findings),
    ...(policy.taskId === undefined ? {} : { taskId: policy.taskId })
  };
}

/**
 * Read a persisted mark. Strict on the ENVELOPE: the version must match
 * exactly, so a forged or future-versioned shape reads as absent rather than as
 * trusted.
 *
 * BOUNDED AND REBUILT (rev8 audit): a persisted mark is DISK-CONTROLLED — an
 * older record written before the cap existed, a hand-edited file, or a torn
 * write. Two defects lived here:
 *   * `findings` had no cardinality OR byte bound, so a legacy 64-finding mark
 *     with 1 MB fields read back as a 25.6 MB object and was re-persisted into
 *     the tree pool (measured: 25,604,367 B for one tree record);
 *   * entries were never validated at all, so `findings: [null]` was accepted
 *     and then crashed `treeEvidenceIntegrityMark` / `quarantineTrajectory` on
 *     `.kind` — a corrupt log line could fail an entire run.
 * Every entry is now rebuilt through the same choke point the producers use:
 * unusable entries are counted as elided, over-long text is truncated. The
 * elided count is ADDED to any the record already declared, so a bounded mark
 * can never under-report through a second pass.
 *
 * A mark that is already well-formed and within both bounds is returned as the
 * SAME object, so nothing about the pre-cap byte shape or identity changes.
 */
export function readEvidenceIntegrityMark(metadata: unknown): EvidenceIntegrityMark | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const raw = metadata[EVIDENCE_INTEGRITY_METADATA_KEY];
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw['version'] !== EVIDENCE_INTEGRITY_VERSION) {
    return undefined;
  }
  if (typeof raw['contaminated'] !== 'boolean' || typeof raw['withheld'] !== 'boolean') {
    return undefined;
  }
  if (!Array.isArray(raw['findings'])) {
    return undefined;
  }
  const mark = raw as unknown as EvidenceIntegrityMark;
  const declaredDropped =
    typeof raw['droppedFindings'] === 'number' &&
    Number.isFinite(raw['droppedFindings']) &&
    raw['droppedFindings'] > 0
      ? raw['droppedFindings']
      : 0;
  // Already within both bounds and fully usable: no rebuild, no clone. A
  // declared `droppedFindings` is also correct here — it is audit data the
  // record already carries, and re-deriving it would produce the same number.
  if (isWellFormedBoundedFindings(mark.findings)) {
    return mark;
  }
  const bounded = boundEvidenceIntegrityFindings(mark.findings, declaredDropped);
  return { ...mark, ...bounded };
}

/**
 * True when a list already satisfies BOTH bounds and needs no rebuild: every
 * entry is a usable finding whose text fields are within the ceiling, and the
 * list is within the cardinality cap. Lets a normal mark keep object identity.
 */
function isWellFormedBoundedFindings(findings: readonly unknown[]): boolean {
  if (findings.length > EVIDENCE_INTEGRITY_MAX_FINDINGS) {
    return false;
  }
  for (const entry of findings) {
    const normalized = boundEvidenceIntegrityFinding(entry);
    if (normalized === undefined) {
      return false;
    }
    // A truncated field comes back SHORTER than the input; that is a rebuild.
    const source = entry as Record<string, unknown>;
    for (const field of ['location', 'criterionId', 'collidingPath'] as const) {
      const original = source[field];
      if (typeof original === 'string' && original.length > EVIDENCE_INTEGRITY_MAX_TEXT) {
        return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// rev8 W2-propagation: the INNER collector's mark carried across the branch
// boundary.
//
// WHY THIS EXISTS
//   The default production assembly builds `createAgentLoopExecutor`, whose OWN
//   `TrajectoryCollector` is armed with the host policy (src/index.ts:2399-2406).
//   When that inner collector hits contamination it quarantines the content
//   (drops the deliverable, replaces the steps with one neutral note) and writes
//   the ONLY mark into `trajectory.metadata` (quarantineTrajectory below), which
//   the bridge projects to `result.metadata.trajectory`
//   (src/dsh-bridge/agent-loop-executor.ts:517-538). The OUTER collector then
//   finalized from that result and — because it only read the status/steps/
//   deliverable channels and the content was already neutralized — lost the mark:
//   its own re-scan could not rediscover a fact that had been scrubbed.
//
// TRUST BOUNDARY (why a branch cannot gain anything here)
//   * The reader looks at ONE documented channel: `metadata.trajectory`, the
//     nested bag the in-repo bridge writes. Arbitrary result metadata is never
//     consulted and never copied.
//   * A carried mark is accepted ONLY as a DENIAL: exact `version`,
//     `contaminated === true`, `withheld === true`, and a non-empty, strictly
//     validated `findings` list. A "clean" claim (`contaminated: false`) is not
//     read at all — an untrusted branch can never declare itself clean, and the
//     host-owned re-scan still runs and stays authoritative.
//   * The accepted mark is REBUILT from the validated fields, so unknown keys or
//     oversized payloads cannot ride into the persisted trajectory/tree mark.
//   * The only effect a (forged or genuine) contaminated mark can have is to
//     withhold its own evidence. It cannot raise a reward, admit a record or
//     promote a tree — the deny-only direction is the whole security argument.
// ---------------------------------------------------------------------------

/** The result-metadata key the agent-loop bridge nests inner trajectory metadata under. */
export const INNER_TRAJECTORY_METADATA_KEY = 'trajectory' as const;

/** Longest string accepted from a carried mark, in characters. */
const CARRIED_TEXT_LIMIT = EVIDENCE_INTEGRITY_MAX_TEXT;

function carriedText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > CARRIED_TEXT_LIMIT) {
    return undefined;
  }
  return value;
}

function carriedCount(value: unknown): number | undefined {
  return boundedCount(value);
}

/** The kinds a carried mark may declare (there are only three, total). */
const CARRIED_FAULT_KINDS = FAULT_KINDS;

/**
 * Validate ONE carried finding and rebuild it from known fields only.
 * `undefined` means the finding — and therefore the whole mark — is malformed.
 *
 * STRICT on purpose: this channel is branch-controlled, so an over-long field
 * is a malformed claim (it voids the whole mark) rather than a value to
 * truncate. The host-owned producers truncate instead; both bound the bytes.
 */
function normalizeCarriedFinding(raw: unknown): EvidenceIntegrityFinding | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !CARRIED_FAULT_KINDS.has(kind)) {
    return undefined;
  }
  const location = carriedText(raw['location']);
  if (location === undefined) {
    return undefined;
  }
  const criterionId = carriedText(raw['criterionId']);
  const collidingPath = carriedText(raw['collidingPath']);
  const sharedPassages = carriedCount(raw['sharedPassages']);
  const matchedCriteria = carriedCount(raw['matchedCriteria']);
  const totalCriteria = carriedCount(raw['totalCriteria']);
  // Rebuilt, never passed through: unknown keys and prototype-carried values do
  // not survive this normalisation.
  return {
    kind: kind as EvidenceIntegrityFaultKind,
    location,
    ...(criterionId === undefined ? {} : { criterionId }),
    ...(sharedPassages === undefined ? {} : { sharedPassages }),
    ...(matchedCriteria === undefined ? {} : { matchedCriteria }),
    ...(totalCriteria === undefined ? {} : { totalCriteria }),
    ...(collidingPath === undefined ? {} : { collidingPath })
  };
}

/**
 * Read the inner collector's DENY-ONLY mark from a branch result's metadata.
 *
 * Returns `undefined` for anything that is not a well-formed contamination
 * claim: no channel, a "clean" claim, a foreign version, missing
 * `withheld`/`findings`, or any malformed finding. Absence is the safe default:
 * the caller's own host-policy scan remains the only way evidence passes.
 *
 * A hostile metadata object (a throwing getter or a Proxy that raises on nested
 * reads) carries no mark either: the collector's `finalize` must never throw
 * because of a branch-returned result.
 */
export function readCarriedEvidenceIntegrityMark(
  resultMetadata: unknown
): EvidenceIntegrityMark | undefined {
  try {
    return readCarriedEvidenceIntegrityMarkUnguarded(resultMetadata);
  } catch {
    return undefined;
  }
}

function readCarriedEvidenceIntegrityMarkUnguarded(
  resultMetadata: unknown
): EvidenceIntegrityMark | undefined {
  if (!isRecord(resultMetadata)) {
    return undefined;
  }
  const inner = resultMetadata[INNER_TRAJECTORY_METADATA_KEY];
  if (!isRecord(inner)) {
    return undefined;
  }
  const raw = inner[EVIDENCE_INTEGRITY_METADATA_KEY];
  if (!isRecord(raw)) {
    return undefined;
  }
  // Exact version: a forged or future-versioned shape reads as absent.
  if (raw['version'] !== EVIDENCE_INTEGRITY_VERSION) {
    return undefined;
  }
  // DENY-ONLY: a clean claim is never read, so it can never suppress the scan.
  if (raw['contaminated'] !== true || raw['withheld'] !== true) {
    return undefined;
  }
  const rawFindings = raw['findings'];
  if (!Array.isArray(rawFindings) || rawFindings.length === 0) {
    return undefined;
  }
  // BOUNDED (rev8 audit): this list is BRANCH-CONTROLLED and its accepted
  // result is re-persisted verbatim by `quarantineTrajectory`, so an
  // arbitrarily long list used to become an arbitrarily large tree-pool record
  // (measured: 20,000 entries -> 2.57 MB mark; a run's record at 31 MB).
  // EVERY entry is still validated — one malformed entry still voids the whole
  // mark, exactly as before — but only a bounded sample is retained, and the
  // elided count is reported instead of growing the mark.
  const findings = createEvidenceIntegrityFindingSet();
  for (const entry of rawFindings) {
    const finding = normalizeCarriedFinding(entry);
    if (finding === undefined) {
      return undefined;
    }
    findings.offer(finding);
  }
  const taskId = carriedText(raw['taskId']);
  // A carried mark may declare its own elided count (a bounded inner mark
  // legitimately reports one). It is audit-only data, never a gate input; it
  // is ADDED to what this pass elided, so a branch cannot understate the total
  // for a long list (the sum can only grow).
  const declaredDropped = carriedCount(raw['droppedFindings']) ?? 0;
  const dropped = findings.droppedFindings + declaredDropped;
  return {
    version: EVIDENCE_INTEGRITY_VERSION,
    contaminated: true,
    withheld: true,
    findings: findings.findings,
    ...(dropped === 0 ? {} : { droppedFindings: dropped }),
    ...(taskId === undefined ? {} : { taskId })
  };
}

/**
 * Identity of a finding for dedupe purposes: kind, location and the two id
 * fields, and nothing else (counts may legitimately differ between two hits at
 * the same place). JSON-encoded so a separator inside a field cannot merge two
 * distinct findings. No text payload is ever hashed or logged.
 */
function findingKey(finding: EvidenceIntegrityFinding): string {
  return JSON.stringify([
    finding.kind,
    finding.location,
    finding.criterionId ?? '',
    finding.collidingPath ?? ''
  ]);
}

/**
 * Merge the HOST's own re-scan mark with the inner collector's carried mark.
 *
 * Both inputs are contamination claims by construction, so the merged mark is
 * contaminated too. Findings are unioned (deduped), which keeps the outer
 * patch/sentinel rejection AND the inner text finding visible at once: the outer
 * scan can still refuse a colliding component path while the inner mark explains
 * why the trajectory content itself was withheld.
 *
 * BOUNDED (rev8 audit): the union is capped like every other producer, and
 * dedupe is a keyed Set instead of a linear scan per carried finding — the old
 * `Array.some` made a merge of two large lists quadratic (measured 1,000 /
 * 5,000 / 10,000 / 20,000 carried findings: 21 / 334 / 988 / 2,864 ms). Elided
 * counts from both sides are carried forward so the merge never under-reports.
 *
 * The single-sided paths are bounded too: `merge(x, undefined)` used to return
 * `x` VERBATIM, so this function — documented as a bounded producer — could emit
 * an unbounded mark (measured: 900 findings / 100 KB fields passed straight
 * through at 90,040,479 B). A within-bounds input is still returned as the SAME
 * object, so nothing about identity changes for normal marks.
 */
export function mergeEvidenceIntegrityMarks(
  own: EvidenceIntegrityMark | undefined,
  carried: EvidenceIntegrityMark | undefined
): EvidenceIntegrityMark | undefined {
  if (own === undefined) {
    return carried === undefined ? undefined : boundMark(carried);
  }
  if (carried === undefined) {
    return boundMark(own);
  }
  const seen = new Set<string>();
  const union: EvidenceIntegrityFinding[] = [];
  for (const finding of [...own.findings, ...carried.findings]) {
    // Rebuilt through the choke point like everywhere else: a merge input can
    // come from a persisted record, and an unusable entry must be COUNTED
    // rather than enter the union (it used to make `findingKey` throw).
    const normalized = boundEvidenceIntegrityFinding(finding);
    if (normalized === undefined) {
      continue;
    }
    const key = findingKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    union.push(normalized);
  }
  const alreadyDropped =
    (own.droppedFindings ?? 0) +
    (carried.droppedFindings ?? 0);
  const taskId = own.taskId ?? carried.taskId;
  return {
    version: EVIDENCE_INTEGRITY_VERSION,
    contaminated: own.contaminated || carried.contaminated,
    withheld: own.withheld || carried.withheld,
    ...boundEvidenceIntegrityFindings(union, alreadyDropped),
    ...(taskId === undefined ? {} : { taskId })
  };
}

// ---------------------------------------------------------------------------
// #118: quarantine — the withheld replacement
// ---------------------------------------------------------------------------

const CONTAMINATION_WITHHELD_NOTE =
  '(withheld: this evidence carries task answer-key material, so neither its trajectory ' +
  'nor its output may be read. Draw no conclusion from their absence.)';

const SENTINEL_WITHHELD_NOTE = '(trajectory unavailable: missing-trajectory sentinel rejected)';

/**
 * The SAME bounds (cardinality AND per-field bytes, plus entry usability)
 * applied to a whole mark, for the writers that persist one AND for the
 * single-sided merge paths (which used to return their input verbatim).
 * Returns `mark` itself when it already satisfies them (so the pre-cap byte
 * shape and object identity are preserved), else a bounded copy.
 *
 * Declared as a hoisted function so the merge above can use it.
 */
function boundMark(mark: EvidenceIntegrityMark): EvidenceIntegrityMark {
  if ((mark.droppedFindings ?? 0) === 0 && isWellFormedBoundedFindings(mark.findings)) {
    return mark;
  }
  return { ...mark, ...boundEvidenceIntegrityFindings(mark.findings, mark.droppedFindings ?? 0) };
}

/**
 * Replace contaminated evidence with a short neutral note (upstream #118):
 * execution status becomes `failed`, the deliverable is dropped, steps and
 * tool errors are reduced to one neutral system step, and the failure signals
 * name the reason with counts only. Diagnostics survive ONLY when no
 * answer-key text was involved (their content cannot be re-checked here); the
 * mark itself preserves the full finding detail (bounded: see
 * EVIDENCE_INTEGRITY_MAX_FINDINGS — this is where the mark is written into the
 * trajectory that later becomes a persisted tree-pool record).
 */
export function quarantineTrajectory(
  trajectory: ProbeTrajectory,
  mark: EvidenceIntegrityMark
): ProbeTrajectory {
  const bounded = boundMark(mark);
  const hasKeyText = bounded.findings.some((finding) => finding.kind === 'answer-key-text');
  const hasKeyPath = bounded.findings.some((finding) => finding.kind === 'answer-key-path');
  const hasSentinel = bounded.findings.some((finding) => finding.kind === 'missing-trajectory-sentinel');
  const contaminated = hasKeyText || hasKeyPath;

  const neutralText = contaminated
    ? CONTAMINATION_WITHHELD_NOTE
    : SENTINEL_WITHHELD_NOTE;
  const signalCode = hasKeyText
    ? 'evidence-contaminated'
    : hasKeyPath
      ? 'answer-key-path'
      : 'missing-trajectory-sentinel';
  const signalMessage = hasKeyText
    ? 'evidence withheld: answer-key contamination detected (' +
      // Total, not just the retained sample: `findings` is bounded, so
      // reporting its length alone would understate a truncated mark.
      String(bounded.findings.length + (bounded.droppedFindings ?? 0)) +
      ' finding(s))'
    : hasKeyPath
      ? 'patch rejected: component path(s) match answer-key paths; rename the component'
      : 'evidence rejected: missing-trajectory sentinel';
  const errorMessage = hasKeyText
    ? 'evidence withheld: answer-key contamination detected'
    : hasKeyPath
      ? 'patch rejected: answer-key path collision'
      : 'evidence rejected: missing-trajectory sentinel';
  // #175: a path collision is repaired by RENAMING the component (upstream
  // feeds the colliding path back to the editor). Text contamination is not
  // repairable within the run.
  const repairable = !hasKeyText;

  const neutralStep = {
    index: 0,
    at: trajectory.endedAt,
    kind: 'system' as const,
    text: neutralText
  };
  const failureSignals = [
    {
      kind: 'unknown' as const,
      message: signalMessage,
      code: signalCode,
      repairable
    }
  ];
  // Metric derivation stays in ONE place (the collector's own helper).
  const metrics = {
    steps: 1,
    toolCalls: 0,
    toolErrors: 0,
    durationMs: trajectory.metrics.durationMs
  };
  // Sentinel-only findings cannot have leaked into host diagnostics (the
  // sentinel is the diagnostic), so failure visibility is preserved there.
  const originalMetadata = trajectory.metadata;
  const diagnostics =
    contaminated || !isRecord(originalMetadata) || !Array.isArray(originalMetadata['diagnostics'])
      ? undefined
      : (originalMetadata['diagnostics'] as readonly unknown[]).filter(
          (entry): entry is string => typeof entry === 'string'
        );
  // The raw produced artifact NEVER survives quarantine: the withheld note
  // replaces it (upstream #118 swaps trajectory AND output).
  const { deliverable: _rawDeliverable, ...withoutDeliverable } = trajectory;
  return {
    ...withoutDeliverable,
    status: 'failed',
    steps: [neutralStep],
    toolErrors: [],
    failureSignals,
    error: { name: 'EvidenceIntegrityError', message: errorMessage },
    metrics,
    metadata: {
      ...(diagnostics === undefined || diagnostics.length === 0 ? {} : { diagnostics }),
      [EVIDENCE_INTEGRITY_METADATA_KEY]: bounded
    }
  };
}

/** Stable digest of the scan inputs (audit identity, never the key text). */
export function evidenceIntegrityPolicyDigest(policy: EvidenceIntegrityPolicy): string {
  const fingerprint = {
    version: EVIDENCE_INTEGRITY_VERSION,
    taskId: policy.taskId ?? null,
    criteria: (policy.answerKey?.criteria ?? []).map((criterion) => ({
      id: criterion?.id ?? '',
      length: typeof criterion?.text === 'string' ? criterion.text.length : 0
    })),
    visibleTextCount: policy.answerKey?.visibleText?.length ?? 0,
    forbiddenPathSegments: [...(policy.forbiddenPathSegments ?? [])].sort()
  };
  const json = JSON.stringify(fingerprint);
  return 'sha256:' + createHash('sha256').update(json, 'utf8').digest('hex');
}
