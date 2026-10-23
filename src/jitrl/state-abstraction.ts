/**
 * Deterministic JitRL state abstraction (plan section 6.1, P1-1).
 *
 * Ownership: src/jitrl/** (Phase 1 kernel).
 *
 * Every function here is pure: no LLM, no I/O, no Date.now(), no randomness.
 * The abstract state token set is what retriever.ts's Jaccard scoring consumes,
 * so token vocabulary stability is part of the contract:
 *
 *   sig:<signature>            normalized task family (instance-free)
 *   cx:<complexity>            trivial | simple | moderate | complex | unknown
 *   tag:<slug>                 context tags, sorted and deduped
 *   round:<0..4>               clamped round index
 *   depth:<0..4>               clamped parent depth
 *   pslot:<slot>               parent batch slot or 'root'
 *   pfail:<category>           parent failure category or 'none'
 *   mconf:<0..4>               memory-confidence bucket over [0.25,0.5,0.75,0.9]
 *   ref:<status>               reference run status or 'missing'
 *   terr:<0..3>                reference tool-error-rate bucket over [0,0.1,0.3]
 *   sig_fail:<kind>            reference failure signal kinds, sorted
 *
 * The bucket is '+'free: for meta states it is 'meta|<signature>|<complexity>',
 * matching the plan's section 5.1 bucket example. (The section 6.1 pseudocode
 * writes 'meta|' + t[1], where t[1] is the complexity token; that appears to be
 * a transcription slip, and the explicit bucket format in the task brief and
 * section 5.1 is used instead.)
 *
 * Instance details never enter tokens: uuids, long numbers, absolute paths,
 * quoted literals, URLs and file names are stripped, while file extensions are
 * kept only as an 'ext:<ext>' category.
 *
 * Credential-shaped text (provider tokens, keys, passwords) is additionally
 * scrubbed through ./redaction BEFORE tokenization (repair B2), so no secret
 * fragment reaches tokens, bucket or summary; two tasks differing only in
 * the secret value keep identical signatures and buckets.
 */

import {
  BATCH_SLOT_KINDS,
  FAILURE_CATEGORIES,
  TASK_COMPLEXITIES,
  type AbstractState,
  type BatchSlotKind,
  type FailureCategory,
  type FailureSignal,
  type FailureSignalKind,
  type GuidanceMode,
  type ProbeTask,
  type TaskComplexity,
  type TrajectoryStatus
} from '../types/contracts';
import { redactSecrets } from './redaction';

/** Reference status seen by L1; 'missing' means no reference run exists yet. */
export type JitReferenceStatus = TrajectoryStatus | 'missing';

/** Structural parent failure input; FailureDiagnosis is assignable to it. */
export interface ParentFailureLike {
  readonly category: FailureCategory;
}

/** Input for one L1 meta-state abstraction (plan section 6.1). */
export interface MetaStateInput {
  readonly task: ProbeTask;
  readonly round: number;
  readonly parentDepth: number;
  readonly parentSlot?: BatchSlotKind;
  readonly parentFailure?: ParentFailureLike;
  readonly memoryConfidence: number;
  /** null is accepted and treated as 'missing'. */
  readonly referenceStatus: JitReferenceStatus | null;
  readonly referenceToolErrorRate?: number;
  readonly referenceFailureSignals?: readonly FailureSignal[];
}

/** Input for one L2 proposal-state abstraction. */
export interface ProposalStateInput extends MetaStateInput {
  readonly slot: BatchSlotKind;
  readonly guidance: GuidanceMode;
  /** Signature of the parent patch; omitted for root proposals. */
  readonly parentPatchSignature?: string;
}

/** Host turn outcome kinds from plan section 6.5. */
export const HOST_TURN_KINDS = [
  'completed',
  'error',
  'max_tokens',
  'aborted',
  'unknown'
] as const;
export type HostTurnKind = (typeof HOST_TURN_KINDS)[number];

/** Input for one L3 host-tool state abstraction. */
export interface HostStateInput {
  /** Recent tool names in call order; only the last `recentWindow` are used. */
  readonly recentToolNames?: readonly string[];
  /** Last observed error class, e.g. 'tool_error'; defaults to 'none'. */
  readonly lastErrorClass?: string;
  readonly turnKind?: HostTurnKind;
  /** Coarse working-directory category, e.g. 'repo', 'tmp', 'home'. */
  readonly workingDirCategory?: string;
  /** How many trailing tool names to keep; defaults to 3 and is clamped to 1..8. */
  readonly recentWindow?: number;
}

const REFERENCE_STATUSES: readonly JitReferenceStatus[] = [
  'succeeded',
  'failed',
  'timeout',
  'aborted',
  'missing'
];

const MAX_ROUND = 4;
const MAX_DEPTH = 4;
const MEMORY_CONFIDENCE_CUTS: readonly number[] = [0.25, 0.5, 0.75, 0.9];
const TOOL_ERROR_RATE_CUTS: readonly number[] = [0, 0.1, 0.3];

/** Output formats recognized by the signature derivation, in priority order. */
const OUTPUT_FORMATS = [
  'json',
  'table',
  'code',
  'report',
  'patch',
  'migration',
  'test'
] as const;

/** File extensions kept only as a category token. */
const FILE_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'md',
  'json',
  'yaml',
  'yml',
  'sh',
  'bash',
  'txt',
  'csv',
  'html',
  'css',
  'go',
  'rs',
  'java',
  'rb',
  'sql',
  'toml',
  'ini'
] as const;

const VERBS = new Set<string>([
  'implement',
  'add',
  'fix',
  'refactor',
  'create',
  'build',
  'write',
  'update',
  'remove',
  'delete',
  'migrate',
  'test',
  'debug',
  'review',
  'analyze',
  'analyse',
  'generate',
  'convert',
  'extract',
  'parse',
  'validate',
  'optimize',
  'optimise',
  'document',
  'explain',
  'design',
  'deploy',
  'configure',
  'install',
  'run',
  'check',
  'find',
  'search',
  'summarize',
  'summarise',
  'translate',
  'rewrite',
  'improve',
  'support',
  'handle',
  'read',
  'load',
  'save',
  'export',
  'import',
  'list',
  'merge',
  'split',
  'clean',
  'format',
  'lint',
  'benchmark',
  'investigate',
  'resolve',
  'ensure',
  'enable',
  'disable',
  'extend',
  'replace',
  'rename',
  'move',
  'copy',
  'compare',
  'verify',
  'mock',
  'render',
  'compile',
  'bundle',
  'publish',
  'upgrade',
  'downgrade',
  'pin',
  'bump'
]);

const STOPWORDS = new Set<string>([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'else',
  'for',
  'from',
  'in',
  'into',
  'on',
  'at',
  'to',
  'of',
  'by',
  'with',
  'without',
  'about',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'we',
  'you',
  'i',
  'they',
  'he',
  'she',
  'please',
  'can',
  'could',
  'should',
  'would',
  'will',
  'shall',
  'may',
  'might',
  'must',
  'do',
  'does',
  'did',
  'done',
  'need',
  'needs',
  'want',
  'wants',
  'make',
  'makes',
  'use',
  'using',
  'used',
  'via',
  'per',
  'also',
  'just',
  'only',
  'very',
  'more',
  'most',
  'some',
  'any',
  'all',
  'each',
  'both',
  'up',
  'down',
  'out',
  'over',
  'under',
  'again',
  'further',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'what',
  'which',
  'who',
  'whom',
  'whose',
  'not',
  'no',
  'nor',
  'so',
  'than',
  'too',
  'file',
  'files',
  'folder',
  'folders',
  'path',
  'paths',
  'directory',
  'repo',
  'project'
]);

/** Lowercase slug used for tags, slots and signature fragments. */
function slugToken(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '');
  return slug.length === 0 ? 'unknown' : slug;
}

/** Truncate long tokens so a single instance value cannot bloat a bucket. */
function boundedSlug(value: string, maxLength = 32): string {
  // Repair B2: tags, parent patch signatures and host strings are free text;
  // scrub secrets before they can become tokens (idempotent, bucket-stable).
  const slug = slugToken(redactSecrets(value));
  return slug.length <= maxLength ? slug : slug.slice(0, maxLength);
}

function isKnown<T extends string>(value: unknown, known: readonly T[]): value is T {
  return typeof value === 'string' && (known as readonly string[]).includes(value);
}

function clampInt(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const floored = Math.floor(value);
  if (floored < 0) {
    return 0;
  }
  return floored > max ? max : floored;
}

function dedupe(tokens: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

/**
 * Count how many cuts are <= value. Buckets are inclusive at each cut, so with
 * cuts [0.25, 0.5, 0.75, 0.9] the value 0.24 lands in bucket 0 and 0.25 in
 * bucket 1. The result range is 0..cuts.length.
 */
export function bucketize(value: number, cuts: readonly number[]): number {
  if (!Number.isFinite(value)) {
    throw new RangeError('bucketize: value must be a finite number');
  }
  let previous = -Infinity;
  for (const cut of cuts) {
    if (!Number.isFinite(cut) || cut <= previous) {
      throw new RangeError('bucketize: cuts must be strictly increasing finite numbers');
    }
    previous = cut;
  }
  let bucket = 0;
  for (const cut of cuts) {
    if (value >= cut) {
      bucket += 1;
    }
  }
  return bucket;
}

/**
 * Tool-error-rate bucket with the plan's [0, 0.1, 0.3] cuts. A zero rate is
 * pinned to bucket 0 (a raw inclusive bucketize would give 1 at the 0 cut):
 *   0 -> 0, (0, 0.1] -> 1, (0.1, 0.3] -> 2, > 0.3 -> 3.
 */
function toolErrorBucket(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) {
    return 0;
  }
  if (rate <= 0.1) {
    return 1;
  }
  if (rate <= 0.3) {
    return 2;
  }
  return 3;
}

function detectOutputFormat(loweredPrompt: string): string | null {
  for (const format of OUTPUT_FORMATS) {
    if (new RegExp('\\b' + format + '\\b').test(loweredPrompt)) {
      return format;
    }
  }
  return null;
}

function extractExtensionCategories(loweredPrompt: string): readonly string[] {
  const found = new Set<string>();
  const pattern = new RegExp(
    '\\.(' + FILE_EXTENSIONS.join('|') + ')\\b',
    'g'
  );
  let match = pattern.exec(loweredPrompt);
  while (match !== null) {
    const ext = match[1];
    if (ext !== undefined) {
      found.add(ext);
    }
    match = pattern.exec(loweredPrompt);
  }
  return [...found].sort().slice(0, 3);
}

/**
 * Remove instance details before tokenization. Order matters: quoted literals
 * first so their content (which may contain path-like text) never reaches the
 * path/number scrubbers, then identifiers, then paths, then bare file names.
 */
function scrubInstanceDetails(loweredPrompt: string): string {
  // Repair B2: secrets are scrubbed first so no credential fragment can
  // survive the instance-detail scrubbers below (idempotent).
  let text = redactSecrets(loweredPrompt);
  text = text.replace(/['"`][^'"`]*['"`]/g, ' ');
  text = text.replace(/https?:\/\/\S+/g, ' ');
  text = text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    ' '
  );
  text = text.replace(/\b[a-z]:[\\/][^\s]+/g, ' ');
  text = text.replace(/\\[^\s]+/g, ' ');
  text = text.replace(/(^|\s)\/[^\s]+/g, '$1 ');
  text = text.replace(/\b[a-z0-9_.-]+\/[a-z0-9_./-]+\b/g, ' ');
  text = text.replace(
    new RegExp('\\b[a-z0-9_-]+\\.(' + FILE_EXTENSIONS.join('|') + ')\\b', 'g'),
    ' '
  );
  text = text.replace(/\b[0-9a-f]{7,}\b/g, ' ');
  text = text.replace(/\b\d{4,}\b/g, ' ');
  text = text.replace(/[^a-z0-9+#]+/g, ' ');
  return text;
}

/** Length bound for an explicit task signature (G2-4). */
export const MAX_TASK_SIGNATURE_LENGTH = 96;

/** Result of sanitizeExplicitSignature: the usable signature plus the clamp flag. */
export interface SanitizedSignature {
  readonly signature: string;
  /** True when the explicit signature exceeded MAX_TASK_SIGNATURE_LENGTH. */
  readonly clamped: boolean;
}

/**
 * Redact and length-bound an explicit task signature (G2-4). Trust in the
 * caller's wording is preserved, but a credential inside the signature can
 * no longer reach sig:/bucket/summary or the persisted record, and a
 * pathologically long signature cannot bloat bucket keys. Truncation is a
 * deterministic prefix cut (no hashing), so signatures differing only after
 * the bound keep bucketing identically. The clamp flag is the diagnostic
 * channel: the pure signature path has no side-channel, so callers that
 * need to observe clamping use this function directly.
 */
export function sanitizeExplicitSignature(raw: string): SanitizedSignature {
  const redacted = redactSecrets(raw.trim());
  const clamped = redacted.length > MAX_TASK_SIGNATURE_LENGTH;
  return {
    signature: clamped ? redacted.slice(0, MAX_TASK_SIGNATURE_LENGTH) : redacted,
    clamped
  };
}

/**
 * Deterministic task-family signature. An explicit taskSignature is trusted
 * for wording but still redacted and length-bounded (G2-4); otherwise the
 * signature is derived from the prompt's leading verbs, domain nouns and
 * requested output format.
 */
export function normalizeSignature(task: ProbeTask): string {
  const explicit = typeof task.taskSignature === 'string' ? task.taskSignature.trim() : '';
  if (explicit.length > 0) {
    return sanitizeExplicitSignature(explicit).signature;
  }
  const prompt = typeof task.prompt === 'string' ? task.prompt : '';
  // Repair B2: scrub credentials before signature derivation so a token in
  // the prompt can never become part of sig:<signature> or the bucket key.
  const lowered = redactSecrets(prompt.toLowerCase());
  if (lowered.trim().length === 0) {
    return 'unknown';
  }
  const format = detectOutputFormat(lowered);
  const extensions = extractExtensionCategories(lowered);
  const scrubbed = scrubInstanceDetails(lowered);

  const verbs: string[] = [];
  const nouns: string[] = [];
  const seen = new Set<string>();
  for (const token of scrubbed.split(/\s+/)) {
    if (token.length === 0 || seen.has(token)) {
      continue;
    }
    seen.add(token);
    if (VERBS.has(token) && verbs.length < 2) {
      verbs.push(token);
      continue;
    }
    if (
      token.length >= 3 &&
      !VERBS.has(token) &&
      !STOPWORDS.has(token) &&
      !(OUTPUT_FORMATS as readonly string[]).includes(token) &&
      !(FILE_EXTENSIONS as readonly string[]).includes(token) &&
      !/^\d+$/.test(token) &&
      nouns.length < 3
    ) {
      nouns.push(token);
    }
  }

  const parts: string[] = [...verbs, ...nouns];
  if (format !== null) {
    parts.push('fmt.' + format);
  }
  for (const extension of extensions) {
    parts.push('ext.' + extension);
  }
  return parts.length === 0 ? 'unknown' : dedupe(parts).join('-');
}

interface NormalizedTask {
  readonly signature: string;
  readonly complexity: TaskComplexity;
}

function normalizeTask(task: ProbeTask): NormalizedTask {
  const complexity = isKnown(task.complexity, TASK_COMPLEXITIES)
    ? task.complexity
    : 'unknown';
  return { signature: normalizeSignature(task), complexity };
}

interface MetaTokens {
  readonly tokens: readonly string[];
  readonly signature: string;
  readonly complexity: TaskComplexity;
}

function buildMetaTokens(input: MetaStateInput): MetaTokens {
  const task = input.task;
  const { signature, complexity } = normalizeTask(task);
  const tokens: string[] = ['sig:' + signature, 'cx:' + complexity];

  const tags = new Set<string>();
  for (const tag of task.contextTags ?? []) {
    tags.add(boundedSlug(tag));
  }
  for (const tag of [...tags].sort()) {
    tokens.push('tag:' + tag);
  }

  tokens.push('round:' + clampInt(input.round, MAX_ROUND));
  tokens.push('depth:' + clampInt(input.parentDepth, MAX_DEPTH));
  const parentSlot = isKnown(input.parentSlot, BATCH_SLOT_KINDS)
    ? input.parentSlot
    : 'root';
  tokens.push('pslot:' + parentSlot);
  const parentFailure = isKnown(input.parentFailure?.category, FAILURE_CATEGORIES)
    ? (input.parentFailure as ParentFailureLike).category
    : 'none';
  tokens.push('pfail:' + parentFailure);

  const confidence = Number.isFinite(input.memoryConfidence)
    ? input.memoryConfidence
    : 0;
  tokens.push('mconf:' + bucketize(confidence, MEMORY_CONFIDENCE_CUTS));
  const referenceStatus = isKnown(input.referenceStatus, REFERENCE_STATUSES)
    ? input.referenceStatus
    : 'missing';
  tokens.push('ref:' + referenceStatus);
  tokens.push('terr:' + toolErrorBucket(input.referenceToolErrorRate ?? 0));

  const failureKinds = new Set<string>();
  for (const signal of input.referenceFailureSignals ?? []) {
    failureKinds.add(boundedSlug(String(signal.kind)));
  }
  for (const kind of [...failureKinds].sort()) {
    tokens.push('sig_fail:' + kind);
  }

  return { tokens: dedupe(tokens), signature, complexity };
}

/** Abstract one L1 meta decision point. */
export function abstractMetaState(input: MetaStateInput): AbstractState {
  const meta = buildMetaTokens(input);
  return {
    level: 'meta',
    bucket: 'meta|' + meta.signature + '|' + meta.complexity,
    tokens: meta.tokens,
    summary: meta.tokens.join(' ')
  };
}

/** Abstract one L2 proposal decision point: meta tokens plus slot/guidance. */
export function abstractProposalState(input: ProposalStateInput): AbstractState {
  if (!isKnown(input.slot, BATCH_SLOT_KINDS)) {
    throw new RangeError('abstractProposalState: slot must be a BatchSlotKind');
  }
  if (input.guidance !== 'memory' && input.guidance !== 'guidance_free') {
    throw new RangeError(
      "abstractProposalState: guidance must be 'memory' or 'guidance_free'"
    );
  }
  const meta = buildMetaTokens(input);
  const tokens: string[] = [
    ...meta.tokens,
    'slot:' + input.slot,
    'guidance:' + input.guidance
  ];
  const parentSignature = typeof input.parentPatchSignature === 'string'
    ? input.parentPatchSignature.trim()
    : '';
  if (parentSignature.length > 0) {
    tokens.push('parent_patch_signature:' + boundedSlug(parentSignature));
  }
  const deduped = dedupe(tokens);
  return {
    level: 'proposal',
    bucket:
      'proposal|' +
      meta.signature +
      '|' +
      meta.complexity +
      '|' +
      input.slot +
      '|' +
      input.guidance,
    tokens: deduped,
    summary: deduped.join(' ')
  };
}

/** Abstract one L3 host-tool decision point from a small recent-history window. */
export function abstractHostState(input: HostStateInput): AbstractState {
  const window = Number.isInteger(input.recentWindow)
    ? Math.min(8, Math.max(1, input.recentWindow as number))
    : 3;
  const recent = (input.recentToolNames ?? []).slice(-window);
  const tokens: string[] = [];
  for (const toolName of recent) {
    tokens.push('tool:' + boundedSlug(toolName));
  }
  const errorClass = boundedSlug(
    typeof input.lastErrorClass === 'string' && input.lastErrorClass.trim().length > 0
      ? input.lastErrorClass
      : 'none'
  );
  const turnKind: HostTurnKind = isKnown(input.turnKind, HOST_TURN_KINDS)
    ? input.turnKind
    : 'unknown';
  const workingDir =
    typeof input.workingDirCategory === 'string' &&
    input.workingDirCategory.trim().length > 0
      ? boundedSlug(input.workingDirCategory)
      : 'unknown';
  tokens.push('err:' + errorClass);
  tokens.push('turn:' + turnKind);
  tokens.push('wd:' + workingDir);
  const deduped = dedupe(tokens);
  return {
    level: 'host_tool',
    bucket: 'host|' + errorClass + '|' + turnKind + '|' + workingDir,
    tokens: deduped,
    summary: deduped.join(' ')
  };
}
