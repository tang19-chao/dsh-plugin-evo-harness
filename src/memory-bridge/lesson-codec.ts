/**
 * Canonical Lesson Envelope codec: deterministic Markdown + YAML-frontmatter
 * serialization for every non-native MCP memory backend, plus tolerant
 * extraction of lessons from arbitrary backend payloads (ARCHITECTURE.md 4.1/4.2).
 *
 * The frontmatter carries the machine-readable envelope (JSON-encoded values,
 * stable key order) so round-trips are lossless; the body carries the CCG six
 * elements in the human/LLM-readable form used by 灵枢 and note-based backends.
 */

import type {
  CanonicalLesson,
  HarnessComponentKey,
  LessonExecutionPatch,
  LessonMetricsDelta,
  LessonPolarity,
  LessonVerificationEvidence,
  LessonVisibility
} from '../types/contracts';
import type { DriverLessonRecord, JsonValue } from './spi';
import { djb2Hex, emptyToUndefined, extractScopeTag } from './namespace';
import type { EmbeddedScriptSpec } from './script-syntax';
import { isScriptLanguage } from './script-syntax';

/** Marker key proving a document is a Harness² lesson envelope. */
export const LESSON_FRONTMATTER_KEY = 'harness_lesson';

/** Tag applied to note-based backends (ARCHITECTURE.md 4.2 driver 4). */
export const LESSON_TAG = 'harness-lesson';

const POLARITIES: readonly string[] = ['positive', 'negative'];
const VISIBILITIES: readonly string[] = ['branch_private', 'session', 'global'];

/** Serialize one lesson into a deterministic Markdown + frontmatter document. */
export function serializeLesson(
  lesson: CanonicalLesson,
  options: { readonly namespace?: string } = {}
): string {
  const frontmatter: (readonly [string, JsonValue])[] = [
    [LESSON_FRONTMATTER_KEY, 1],
    ['id', lesson.id],
    ['title', lesson.title],
    ['whenToApply', [...lesson.whenToApply]],
    ['subFunctions', [...lesson.subFunctions]],
    ['executionPatch', executionPatchJson(lesson.executionPatch)],
    ['verificationEvidence', verificationEvidenceJson(lesson.verificationEvidence)],
    ['whenNotToApply', [...lesson.whenNotToApply]],
    ['polarity', lesson.polarity],
    ['visibility', lesson.visibility],
    ['sessionId', lesson.sessionId]
  ];
  pushOptional(frontmatter, 'branchId', lesson.branchId);
  pushOptional(frontmatter, 'schemaVersion', lesson.schemaVersion);
  pushOptional(frontmatter, 'createdAt', lesson.createdAt);
  pushOptional(frontmatter, 'tags', lesson.tags === undefined ? undefined : [...lesson.tags]);
  pushOptional(frontmatter, 'confidence', lesson.confidence);
  pushOptional(frontmatter, 'taskSignature', lesson.taskSignature);
  pushOptional(frontmatter, 'sourceTreeId', lesson.sourceTreeId);
  pushOptional(frontmatter, 'namespace', options.namespace);
  pushOptional(
    frontmatter,
    'metadata',
    lesson.metadata === undefined ? undefined : (lesson.metadata as unknown as JsonValue)
  );
  const lines: string[] = ['---'];
  for (const [key, value] of frontmatter) {
    lines.push(key + ': ' + JSON.stringify(value));
  }
  lines.push('---', '', renderLessonMarkdown(lesson));
  return lines.join('\n');
}

function pushOptional(
  target: (readonly [string, JsonValue])[],
  key: string,
  value: JsonValue | undefined
): void {
  if (value !== undefined && value !== null) {
    target.push([key, value]);
  }
}

function executionPatchJson(patch: LessonExecutionPatch): JsonValue {
  const record: { [key: string]: JsonValue } = { summary: patch.summary };
  if (patch.componentDiffs !== undefined) {
    record.componentDiffs = { ...patch.componentDiffs } as JsonValue;
  }
  if (patch.patchId !== undefined) {
    record.patchId = patch.patchId;
  }
  return record;
}

function verificationEvidenceJson(evidence: LessonVerificationEvidence): JsonValue {
  const record: { [key: string]: JsonValue } = {
    referenceFailure: evidence.referenceFailure,
    candidateSuccess: evidence.candidateSuccess,
    metricsDelta: {
      stepsDiff: evidence.metricsDelta.stepsDiff,
      toolErrorsDiff: evidence.metricsDelta.toolErrorsDiff
    }
  };
  if (evidence.referenceTrajectoryId !== undefined) {
    record.referenceTrajectoryId = evidence.referenceTrajectoryId;
  }
  if (evidence.candidateTrajectoryId !== undefined) {
    record.candidateTrajectoryId = evidence.candidateTrajectoryId;
  }
  return record;
}

/**
 * Render the six CCG elements as Markdown. This is the exact text handed to
 * white-box native backends (灵枢 cg(op='write')).
 */
export function renderLessonMarkdown(lesson: CanonicalLesson): string {
  const lines: string[] = [];
  lines.push(RENDERED_TITLE_PREFIX + lesson.title);
  lines.push('');
  lines.push('## 生效条件 / whenToApply');
  lines.push(...bulletLines(lesson.whenToApply, '（未声明）'));
  lines.push('');
  lines.push('## 子功能 / subFunctions');
  lines.push(...bulletLines(lesson.subFunctions, '（未声明）'));
  lines.push('');
  lines.push('## 执行动作 / executionPatch');
  lines.push(lesson.executionPatch.summary);
  if (lesson.executionPatch.componentDiffs !== undefined) {
    for (const [key, value] of Object.entries(lesson.executionPatch.componentDiffs)) {
      lines.push('');
      lines.push('### componentDiff: ' + key);
      lines.push(value);
    }
  }
  lines.push('');
  lines.push('## 验证方式 / verificationEvidence');
  lines.push('- 参考分支失败: ' + lesson.verificationEvidence.referenceFailure);
  lines.push('- 候选分支成功: ' + lesson.verificationEvidence.candidateSuccess);
  lines.push(
    '- 指标变化: stepsDiff=' +
      lesson.verificationEvidence.metricsDelta.stepsDiff +
      ', toolErrorsDiff=' +
      lesson.verificationEvidence.metricsDelta.toolErrorsDiff
  );
  lines.push('');
  lines.push('## 不适用条件 / whenNotToApply');
  lines.push(...bulletLines(lesson.whenNotToApply, '（未声明）'));
  lines.push('');
  lines.push('<!-- ' + renderTrailer(lesson) + ' -->');
  return lines.join('\n');
}

/**
 * Machine-readable trailer of the rendered form. It is an HTML comment so
 * white-box native backends (灵枢 cg(op='write')) only see the six CCG elements,
 * while the bridge can still recover identity and governance fields on recall.
 */
function renderTrailer(lesson: CanonicalLesson): string {
  const parts: string[] = [
    'polarity: ' + lesson.polarity,
    'visibility: ' + lesson.visibility,
    'id: ' + lesson.id,
    'sessionId: ' + lesson.sessionId
  ];
  if (lesson.branchId !== undefined) {
    parts.push('branchId: ' + lesson.branchId);
  }
  if (typeof lesson.confidence === 'number') {
    parts.push('confidence: ' + lesson.confidence);
  }
  return parts.join('; ');
}

function bulletLines(values: readonly string[], emptyText: string): string[] {
  if (values.length === 0) {
    return ['- ' + emptyText];
  }
  return values.map((value) => '- ' + value);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parsed lesson plus the namespace it was stored under. */
export interface ParsedLessonEnvelope {
  readonly lesson: CanonicalLesson;
  readonly namespace: string;
}

/** Parse one serialized lesson document; undefined when not a valid envelope. */
export function parseLessonEnvelope(text: string): ParsedLessonEnvelope | undefined {
  if (typeof text !== 'string' || text.length === 0) {
    return undefined;
  }
  const fields = parseFrontmatter(text);
  if (fields === undefined) {
    return undefined;
  }
  const lesson = lessonFromFields(fields);
  if (lesson === undefined) {
    return undefined;
  }
  const tagged = extractScopeTag(text);
  const namespace = typeof fields.namespace === 'string' ? fields.namespace : tagged ?? '';
  return { lesson, namespace };
}

function parseFrontmatter(text: string): Record<string, JsonValue> | undefined {
  const match = /(?:^|\n)---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  const fields: Record<string, JsonValue> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (key.length === 0 || rawValue.length === 0) {
      continue;
    }
    try {
      fields[key] = JSON.parse(rawValue) as JsonValue;
    } catch {
      fields[key] = rawValue;
    }
  }
  if (fields[LESSON_FRONTMATTER_KEY] === undefined) {
    return undefined;
  }
  return fields;
}

function lessonFromFields(fields: Record<string, JsonValue>): CanonicalLesson | undefined {
  const id = asString(fields.id);
  const title = asString(fields.title);
  const whenToApply = asStringArray(fields.whenToApply);
  const whenNotToApply = asStringArray(fields.whenNotToApply);
  const subFunctions = asStringArray(fields.subFunctions) as HarnessComponentKey[] | undefined;
  const polarity = asString(fields.polarity);
  const visibility = asString(fields.visibility);
  const sessionId = asString(fields.sessionId);
  const executionPatch = asExecutionPatch(fields.executionPatch);
  const verificationEvidence = asVerificationEvidence(fields.verificationEvidence);
  if (
    id === undefined ||
    title === undefined ||
    whenToApply === undefined ||
    whenNotToApply === undefined ||
    subFunctions === undefined ||
    polarity === undefined ||
    visibility === undefined ||
    sessionId === undefined ||
    executionPatch === undefined ||
    verificationEvidence === undefined
  ) {
    return undefined;
  }
  if (!POLARITIES.includes(polarity) || !VISIBILITIES.includes(visibility)) {
    return undefined;
  }
  const lesson: CanonicalLesson = {
    id,
    title,
    whenToApply,
    subFunctions,
    executionPatch,
    verificationEvidence,
    whenNotToApply,
    polarity: polarity as LessonPolarity,
    visibility: visibility as LessonVisibility,
    sessionId
  };
  const branchId = asString(fields.branchId);
  const tags = asStringArray(fields.tags);
  const taskSignature = asString(fields.taskSignature);
  const sourceTreeId = asString(fields.sourceTreeId);
  const confidence = asNumber(fields.confidence);
  const createdAt = asNumber(fields.createdAt);
  const metadata = asMetadata(fields.metadata);
  return {
    ...lesson,
    ...(branchId === undefined ? {} : { branchId }),
    ...(tags === undefined ? {} : { tags }),
    ...(taskSignature === undefined ? {} : { taskSignature }),
    ...(sourceTreeId === undefined ? {} : { sourceTreeId }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(metadata === undefined ? {} : { metadata })
  };
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return undefined;
    }
    result.push(entry);
  }
  return result;
}

function asMetadata(value: JsonValue | undefined): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Readonly<Record<string, unknown>>;
}

function asExecutionPatch(value: JsonValue | undefined): LessonExecutionPatch | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, JsonValue>;
  const summary = asString(record.summary);
  if (summary === undefined) {
    return undefined;
  }
  const patchId = asString(record.patchId);
  const diffsRaw = record.componentDiffs;
  const componentDiffs: Record<string, string> = {};
  if (diffsRaw !== undefined && diffsRaw !== null && typeof diffsRaw === 'object' && !Array.isArray(diffsRaw)) {
    for (const [key, entry] of Object.entries(diffsRaw as Record<string, JsonValue>)) {
      if (typeof entry === 'string') {
        componentDiffs[key] = entry;
      }
    }
  }
  const hasDiffs = Object.keys(componentDiffs).length > 0;
  return {
    summary,
    ...(hasDiffs ? { componentDiffs } : {}),
    ...(patchId === undefined ? {} : { patchId })
  };
}

function asVerificationEvidence(value: JsonValue | undefined): LessonVerificationEvidence | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, JsonValue>;
  const referenceFailure = asString(record.referenceFailure);
  const candidateSuccess = asString(record.candidateSuccess);
  if (referenceFailure === undefined || candidateSuccess === undefined) {
    return undefined;
  }
  const deltaRaw = record.metricsDelta;
  let metricsDelta: LessonMetricsDelta = { stepsDiff: 0, toolErrorsDiff: 0 };
  if (deltaRaw !== undefined && deltaRaw !== null && typeof deltaRaw === 'object' && !Array.isArray(deltaRaw)) {
    const delta = deltaRaw as Record<string, JsonValue>;
    metricsDelta = {
      stepsDiff: asNumber(delta.stepsDiff) ?? 0,
      toolErrorsDiff: asNumber(delta.toolErrorsDiff) ?? 0
    };
  }
  const referenceTrajectoryId = asString(record.referenceTrajectoryId);
  const candidateTrajectoryId = asString(record.candidateTrajectoryId);
  return {
    referenceFailure,
    candidateSuccess,
    metricsDelta,
    ...(referenceTrajectoryId === undefined ? {} : { referenceTrajectoryId }),
    ...(candidateTrajectoryId === undefined ? {} : { candidateTrajectoryId })
  };
}

/** True when a text looks like a serialized lesson (either supported form). */
export function isLessonDocument(text: string): boolean {
  return (
    typeof text === 'string' &&
    (text.includes(LESSON_FRONTMATTER_KEY) || text.includes(RENDERED_TITLE_PREFIX))
  );
}

/**
 * Parse a lesson document in either supported form: the machine-readable
 * frontmatter envelope, or the rendered six-element Markdown emitted for
 * white-box native backends (which keep the CCG text plus an HTML trailer).
 */
export function parseLessonDocument(text: string): ParsedLessonEnvelope | undefined {
  const envelope = parseLessonEnvelope(text);
  if (envelope !== undefined) {
    return envelope;
  }
  return parseRenderedLesson(text);
}

/** Heading prefix of the rendered CCG form (功能名 = function name). */
export const RENDERED_TITLE_PREFIX = '# 功能名：';

const SECTION_KEYS: readonly (readonly [string, string])[] = [
  ['生效条件', 'whenToApply'],
  ['子功能', 'subFunctions'],
  ['执行动作', 'executionPatch'],
  ['验证方式', 'verificationEvidence'],
  ['不适用条件', 'whenNotToApply']
];

/**
 * Parse the rendered six-element Markdown back into a CanonicalLesson. Used for
 * backends that store human/LLM-readable text (灵枢 native, note libraries).
 */
export function parseRenderedLesson(text: string): ParsedLessonEnvelope | undefined {
  if (typeof text !== 'string' || !text.includes(RENDERED_TITLE_PREFIX)) {
    return undefined;
  }
  const sections = new Map<string, string[]>();
  const componentDiffs: Record<string, string> = {};
  let trailer = '';
  let title: string | undefined;
  let current: string | undefined;
  let diffKey: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
      trailer = trimmed.slice(4, -3).trim();
      continue;
    }
    if (line.startsWith(RENDERED_TITLE_PREFIX)) {
      title = line.slice(RENDERED_TITLE_PREFIX.length).trim();
      current = undefined;
      diffKey = undefined;
      continue;
    }
    if (line.startsWith('### ')) {
      const heading = line.slice(4).trim();
      const marker = 'componentDiff:';
      if (current === 'executionPatch' && heading.startsWith(marker)) {
        diffKey = heading.slice(marker.length).trim();
        componentDiffs[diffKey] = '';
        continue;
      }
      current = undefined;
      diffKey = undefined;
      continue;
    }
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim();
      current = undefined;
      diffKey = undefined;
      for (const [label, key] of SECTION_KEYS) {
        if (heading.includes(label) || heading.includes(key)) {
          current = key;
          break;
        }
      }
      if (current !== undefined && !sections.has(current)) {
        sections.set(current, []);
      }
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if (diffKey !== undefined) {
      componentDiffs[diffKey] = componentDiffs[diffKey] === '' ? line : componentDiffs[diffKey] + '\n' + line;
      continue;
    }
    sections.get(current)?.push(line);
  }

  if (title === undefined) {
    return undefined;
  }
  const trailerFields = parseTrailer(trailer);
  const polarity = trailerFields.polarity;
  const visibility = trailerFields.visibility;
  const sessionId = trailerFields.sessionId;
  if (
    polarity === undefined ||
    visibility === undefined ||
    sessionId === undefined ||
    !POLARITIES.includes(polarity) ||
    !VISIBILITIES.includes(visibility)
  ) {
    return undefined;
  }
  const verificationLines = sections.get('verificationEvidence') ?? [];
  const referenceFailure = firstMatch(verificationLines, /参考分支失败[:：]\s*(.*)$/);
  const candidateSuccess = firstMatch(verificationLines, /候选分支成功[:：]\s*(.*)$/);
  const deltaLine = verificationLines.find((line) => line.includes('stepsDiff=')) ?? '';
  const stepsDiff = Number.parseInt(/stepsDiff=(-?\d+)/.exec(deltaLine)?.[1] ?? '0', 10);
  const toolErrorsDiff = Number.parseInt(/toolErrorsDiff=(-?\d+)/.exec(deltaLine)?.[1] ?? '0', 10);
  const summaryLines = sections.get('executionPatch') ?? [];
  const lesson: CanonicalLesson = {
    id: trailerFields.id ?? 'rendered-' + djb2Hex(title),
    title,
    whenToApply: bullets(sections.get('whenToApply')),
    subFunctions: bullets(sections.get('subFunctions')) as HarnessComponentKey[],
    executionPatch: {
      summary: summaryLines.join('\n').trim(),
      ...(Object.keys(componentDiffs).length === 0 ? {} : { componentDiffs })
    },
    verificationEvidence: {
      referenceFailure: referenceFailure ?? '',
      candidateSuccess: candidateSuccess ?? '',
      metricsDelta: {
        stepsDiff: Number.isFinite(stepsDiff) ? stepsDiff : 0,
        toolErrorsDiff: Number.isFinite(toolErrorsDiff) ? toolErrorsDiff : 0
      }
    },
    whenNotToApply: bullets(sections.get('whenNotToApply')),
    polarity: polarity as LessonPolarity,
    visibility: visibility as LessonVisibility,
    sessionId
  };
  const branchId = trailerFields.branchId;
  const confidence = trailerFields.confidence === undefined ? undefined : Number.parseFloat(trailerFields.confidence);
  const namespace = extractScopeTag(text) ?? '';
  return {
    lesson: {
      ...lesson,
      ...(branchId === undefined ? {} : { branchId }),
      ...(confidence === undefined || !Number.isFinite(confidence) ? {} : { confidence })
    },
    namespace
  };
}

function bullets(lines: readonly string[] | undefined): string[] {
  if (lines === undefined) {
    return [];
  }
  const result: string[] = [];
  for (const line of lines) {
    const match = /^-\s*(.*)$/.exec(line);
    const value = (match?.[1] ?? line).trim();
    if (value.length === 0 || value === '（未声明）') {
      continue;
    }
    result.push(value);
  }
  return result;
}

function firstMatch(lines: readonly string[], pattern: RegExp): string | undefined {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match?.[1] !== undefined) {
      return match[1].trim();
    }
  }
  return undefined;
}

function parseTrailer(trailer: string): Record<string, string> {
  const fields: Record<string, string> = {};
  if (trailer.length === 0) {
    return fields;
  }
  for (const part of trailer.split(';')) {
    const separator = part.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key.length > 0 && value.length > 0) {
      fields[key] = value;
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Payload extraction
// ---------------------------------------------------------------------------

const NAMESPACE_KEYS = ['namespace', 'group_id', 'groupId', 'user_id', 'userId', 'scope', 'container'] as const;
const PATH_KEYS = ['path', 'file_path', 'filePath', 'uri'] as const;

/** Options for collectLessonRecords. */
export interface CollectLessonOptions {
  /** Namespace supplied by the driver (already derived from scope). */
  readonly namespaceHint?: string;
  /** Fallback when the payload carries no namespace information. */
  readonly defaultNamespace?: string;
}

/**
 * Walk an arbitrary backend payload and extract every valid lesson envelope,
 * remembering the namespace carried by the enclosing object (metadata/group
 * ids/paths) or by the envelope frontmatter itself.
 */
export function collectLessonRecords(value: unknown, options: CollectLessonOptions = {}): DriverLessonRecord[] {
  const records: DriverLessonRecord[] = [];
  const seen = new Set<string>();
  walk(value, undefined, 0);
  return records;

  function walk(node: unknown, inheritedNamespace: string | undefined, depth: number): void {
    if (depth > 12 || node === null || node === undefined) {
      return;
    }
    if (typeof node === 'string') {
      addFromText(node, inheritedNamespace);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry, inheritedNamespace, depth + 1);
      }
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    const obj = node as Record<string, unknown>;
    let namespace = inheritedNamespace;
    for (const key of NAMESPACE_KEYS) {
      const candidate = obj[key];
      if (typeof candidate === 'string' && candidate.length > 0) {
        namespace = candidate;
        break;
      }
      if (Array.isArray(candidate) && typeof candidate[0] === 'string' && candidate[0].length > 0) {
        namespace = candidate[0];
        break;
      }
    }
    const metadata = obj.metadata;
    if (namespace === inheritedNamespace && metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const meta = metadata as Record<string, unknown>;
      for (const key of NAMESPACE_KEYS) {
        const candidate = meta[key];
        if (typeof candidate === 'string' && candidate.length > 0) {
          namespace = candidate;
          break;
        }
      }
    }
    for (const key of PATH_KEYS) {
      const candidate = obj[key];
      if (namespace === inheritedNamespace && typeof candidate === 'string' && candidate.length > 0) {
        const directory = candidate.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
        if (directory.length > 0) {
          namespace = directory;
        }
      }
    }
    for (const entry of Object.values(obj)) {
      walk(entry, namespace, depth + 1);
    }
  }

  function addFromText(text: string, inheritedNamespace: string | undefined): void {
    if (!isLessonDocument(text)) {
      return;
    }
    const parsed = parseLessonDocument(text);
    if (parsed === undefined) {
      return;
    }
    const namespace =
      emptyToUndefined(parsed.namespace) ??
      emptyToUndefined(inheritedNamespace) ??
      emptyToUndefined(options.namespaceHint) ??
      emptyToUndefined(options.defaultNamespace) ??
      '';
    const key = namespace + '#' + parsed.lesson.id;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    records.push({ lesson: parsed.lesson, namespace, backendRef: parsed.lesson.id });
  }
}

/** Namespace recorded inside a lesson envelope's metadata, when present. */
export function lessonNamespace(lesson: CanonicalLesson): string | undefined {
  const metadata = lesson.metadata;
  if (metadata === undefined) {
    return undefined;
  }
  const value = metadata.namespace;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Embedded generated code (scripts / middleware) discovery
// ---------------------------------------------------------------------------

/**
 * Every generated script/middleware artifact embedded in a lesson, from
 * metadata.embeddedScripts / metadata.scripts and from the executionPatch
 * componentDiffs for the 'scripts' and 'plugins' surfaces.
 */
export function extractEmbeddedScripts(lesson: CanonicalLesson): EmbeddedScriptSpec[] {
  const specs: EmbeddedScriptSpec[] = [];
  const metadata = lesson.metadata;
  if (metadata !== undefined) {
    collectScriptsFromValue(metadata.embeddedScripts, specs);
    collectScriptsFromValue(metadata.scripts, specs);
  }
  const diffs = lesson.executionPatch.componentDiffs;
  if (diffs !== undefined) {
    const fallbackPath = 'lesson-' + sanitizeFileToken(lesson.id);
    for (const surface of ['scripts', 'plugins'] as const) {
      const raw = diffs[surface];
      if (raw === undefined) {
        continue;
      }
      const parsed = tryParseJson(raw);
      if (parsed !== undefined) {
        collectScriptsFromValue(parsed, specs);
        continue;
      }
      specs.push({
        path: fallbackPath + (surface === 'plugins' ? '.mw.ts' : '.script.txt'),
        language: surface === 'plugins' ? 'typescript' : 'javascript',
        code: raw
      });
    }
  }
  return dedupeScripts(specs);
}

function collectScriptsFromValue(value: unknown, target: EmbeddedScriptSpec[]): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectScriptsFromValue(entry, target);
    }
    return;
  }
  if (typeof value !== 'object') {
    return;
  }
  const record = value as Record<string, unknown>;
  const nested = record.scripts;
  if (nested !== undefined) {
    collectScriptsFromValue(nested, target);
  }
  const code = record.code;
  const language = record.language;
  if (typeof code === 'string' && typeof language === 'string' && isScriptLanguage(language)) {
    const path = typeof record.path === 'string' && record.path.length > 0 ? record.path : 'lesson-script.txt';
    target.push({ path, language, code });
  }
}

function dedupeScripts(specs: readonly EmbeddedScriptSpec[]): EmbeddedScriptSpec[] {
  const seen = new Set<string>();
  const result: EmbeddedScriptSpec[] = [];
  for (const spec of specs) {
    const key = spec.path + '\u0000' + spec.language + '\u0000' + spec.code;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(spec);
  }
  return result;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sanitizeFileToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}
