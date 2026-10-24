/**
 * Sanitized event sample format (P6.1-F).
 *
 * A host smoke needs evidence, but the evidence must not become a second
 * payload-echo channel: ADR 0001 §2.3 forbids storing tool arguments or bodies
 * in diagnostics, and P6.1-B1 removed the same class of leak from the mirror.
 * So every observation the harness writes is reduced to this record shape:
 * a bounded vocabulary of structural fields, plus counters. There is no
 * `arguments`, `content`, `text`, `message` or `error.message` field anywhere
 * in the format, which is what makes the guarantee checkable by a test rather
 * than by a reviewer's eye.
 *
 * The format is also the input to the report writer, so this module is the one
 * place that decides what a "passed"/"failed" sample looks like.
 */

/** The hook surfaces a sample can be attributed to. */
export const SAMPLE_SURFACES = [
  'system-prompt/assemble',
  'tools/pre-execute',
  'tools/post-execute',
  'agent/pre-step',
  'turn/end',
  'mcp',
  'runtime-control',
  'collector',
  'mirror'
] as const;
export type SampleSurface = (typeof SAMPLE_SURFACES)[number];

/** The outcome vocabulary of one sample. */
export type SampleOutcome = 'passed' | 'failed' | 'not-run';

/**
 * The only shape a harness record may take.
 *
 * Field notes:
 * - `branchTag`/`sessionTag` are the *test* tags (`hostsmoke-<run>-...`), not
 *   host ids, so the sample never carries a real session identifier;
 * - `identityFields` lists which identity carriers were present (field NAMES);
 * - `counters` holds plugin counters (scopeUnknownSkipped, advisory, ...);
 * - `detail` is a bounded, author-written expectation, never host text.
 */
export interface SanitizedEventSample {
  /** Stable sample id, `<surface>#<n>` within one run. */
  readonly id: string;
  readonly surface: SampleSurface;
  /** Scenario the sample belongs to (the doc §9.2/§9.3 item id). */
  readonly scenario: string;
  /** Test session tag (`hostsmoke-<run>-s1`), never a host session id. */
  readonly sessionTag: string;
  /** Test branch tag (`hostsmoke-<run>-s1-bA`), never a host branch id. */
  readonly branchTag: string;
  /** Test namespace tag; the *declared* test namespace, not a business one. */
  readonly namespaceTag: string;
  /** Identity carrier field names observed on the dispatch (names only). */
  readonly identityFields: readonly string[];
  /** Tool *name* reported by the host pipeline, if the surface has one. */
  readonly toolName?: string;
  /** Plugin counters after the step, if the surface produces any. */
  readonly counters?: Readonly<Record<string, number>>;
  /** Decision kind the adapter returned (`allow`/`ask`/`deny`/`cancel`/`enter`). */
  readonly decision?: string;
  readonly outcome: SampleOutcome;
  /** Author-written, bounded expectation/observation; no host text. */
  readonly detail: string;
}

/** Fields that must never appear on a sample (payload-echo guard list). */
export const FORBIDDEN_SAMPLE_KEYS = [
  'arguments',
  'args',
  'content',
  'text',
  'message',
  'body',
  'payload',
  'error',
  'reason',
  'stdout',
  'stderr'
] as const;

/** Longest `detail` a sample may carry before it is truncated. */
export const MAX_DETAIL_LENGTH = 240;
/** Longest tag a sample may carry. */
export const MAX_TAG_LENGTH = 64;

const TAG_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Truncate a string to `MAX_DETAIL_LENGTH` with an ellipsis marker. */
export function boundDetail(detail: string): string {
  const value = typeof detail === 'string' ? detail : '';
  if (value.length <= MAX_DETAIL_LENGTH) {
    return value;
  }
  return value.slice(0, MAX_DETAIL_LENGTH - 1) + '…';
}

/** Normalize a tag: printable ASCII identifiers only, bounded length. */
export function normalizeTag(raw: string): string {
  const value = typeof raw === 'string' ? raw : '';
  const cleaned = value.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/-+/g, '-');
  const trimmed = cleaned.replace(/^-+|-+$/g, '');
  if (trimmed.length === 0) {
    return 'untagged';
  }
  return trimmed.length <= MAX_TAG_LENGTH ? trimmed : trimmed.slice(0, MAX_TAG_LENGTH);
}

/**
 * Validate one sample against the format.
 *
 * Returns one message per violation. A sample that passes this validator is
 * guaranteed to contain no payload-echo field, so the report writer can treat
 * validator success as the "no payload stored" evidence itself.
 */
export function validateSample(value: unknown): readonly string[] {
  const problems: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['sample is not an object'];
  }
  const sample = value as Record<string, unknown>;
  for (const key of Object.keys(sample)) {
    if ((FORBIDDEN_SAMPLE_KEYS as readonly string[]).includes(key)) {
      problems.push('sample carries forbidden payload field "' + key + '"');
    }
  }
  for (const field of ['id', 'scenario', 'sessionTag', 'branchTag', 'namespaceTag', 'detail'] as const) {
    if (typeof sample[field] !== 'string' || (sample[field] as string).length === 0) {
      problems.push('sample.' + field + ' must be a non-empty string');
    }
  }
  if (typeof sample['detail'] === 'string' && (sample['detail'] as string).length > MAX_DETAIL_LENGTH) {
    problems.push('sample.detail exceeds ' + String(MAX_DETAIL_LENGTH) + ' characters');
  }
  if (!(SAMPLE_SURFACES as readonly string[]).includes(String(sample['surface']))) {
    problems.push('sample.surface must be one of ' + SAMPLE_SURFACES.join('/'));
  }
  const outcome = sample['outcome'];
  if (outcome !== 'passed' && outcome !== 'failed' && outcome !== 'not-run') {
    problems.push('sample.outcome must be passed/failed/not-run');
  }
  for (const field of ['sessionTag', 'branchTag', 'namespaceTag'] as const) {
    if (typeof sample[field] === 'string' && !TAG_PATTERN.test(sample[field] as string)) {
      problems.push('sample.' + field + ' must be an identifier-shaped tag');
    }
  }
  if (!Array.isArray(sample['identityFields'])) {
    problems.push('sample.identityFields must be an array of field names');
  } else if ((sample['identityFields'] as readonly unknown[]).some((entry) => typeof entry !== 'string')) {
    problems.push('sample.identityFields must contain strings only');
  }
  const counters = sample['counters'];
  if (counters !== undefined) {
    if (counters === null || typeof counters !== 'object' || Array.isArray(counters)) {
      problems.push('sample.counters must be an object of numbers');
    } else {
      for (const [key, entry] of Object.entries(counters as Record<string, unknown>)) {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) {
          problems.push('sample.counters.' + key + ' must be a finite number');
        }
      }
    }
  }
  if (sample['toolName'] !== undefined && typeof sample['toolName'] !== 'string') {
    problems.push('sample.toolName must be a string when present');
  }
  if (sample['decision'] !== undefined && typeof sample['decision'] !== 'string') {
    problems.push('sample.decision must be a string when present');
  }
  return problems;
}

/** Build a sample, bounding the free-text fields and dropping undefined keys. */
export function makeSample(
  input: Omit<SanitizedEventSample, 'detail' | 'sessionTag' | 'branchTag' | 'namespaceTag'> & {
    readonly detail: string;
    readonly sessionTag: string;
    readonly branchTag: string;
    readonly namespaceTag: string;
  }
): SanitizedEventSample {
  return {
    id: input.id,
    surface: input.surface,
    scenario: input.scenario,
    sessionTag: normalizeTag(input.sessionTag),
    branchTag: normalizeTag(input.branchTag),
    namespaceTag: normalizeTag(input.namespaceTag),
    identityFields: [...input.identityFields],
    ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
    ...(input.counters === undefined ? {} : { counters: { ...input.counters } }),
    ...(input.decision === undefined ? {} : { decision: input.decision }),
    outcome: input.outcome,
    detail: boundDetail(input.detail)
  };
}

/**
 * Naming convention for the test session/branch/namespace tags.
 *
 * Why a convention instead of free-form names: the smoke must be able to prove
 * that sibling probe branches sharing one session do not leak into each other,
 * and that no business namespace is touched. Both claims are only checkable if
 * every identifier the smoke creates is (a) derived from one run id and (b)
 * recognizable as a test identifier by a simple prefix rule.
 */
export interface SmokeNaming {
  /** Run id (`YYYYMMDDTHHMMSSZ`-shaped, unique per execution). */
  readonly runId: string;
  /** Prefix every test identifier starts with. */
  readonly prefix: string;
  /** Session tags, one per simulated DSH session. */
  readonly sessionTags: readonly string[];
  /** Branch tags per session; the second branch of a session is a sibling. */
  readonly branchTags: Readonly<Record<string, readonly string[]>>;
  /** Test namespaces; `businessNamespace` is the one that must stay untouched. */
  readonly namespaces: {
    readonly primary: string;
    readonly secondary: string;
    readonly businessNamespace: string;
  };
}

/** Test prefix every generated identifier must carry. */
export const SMOKE_PREFIX = 'hostsmoke';

/** Infer a smoke naming scheme from a run id. */
export function smokeNaming(runId: string): SmokeNaming {
  const run = normalizeTag(runId);
  const session1 = SMOKE_PREFIX + '-' + run + '-s1';
  const session2 = SMOKE_PREFIX + '-' + run + '-s2';
  return {
    runId: run,
    prefix: SMOKE_PREFIX,
    sessionTags: [session1, session2],
    branchTags: {
      [session1]: [session1 + '-bA', session1 + '-bB'],
      [session2]: [session2 + '-bA', session2 + '-bB']
    },
    namespaces: {
      primary: SMOKE_PREFIX + '/' + run + '/test-domain',
      secondary: SMOKE_PREFIX + '/' + run + '/test-invariant',
      businessNamespace: 'harness2/jitrl'
    }
  };
}

/**
 * Assert that every identifier in a naming scheme is a test identifier.
 *
 * This is the mechanical half of the "controlled release boundary": a run whose
 * identifiers escape the `hostsmoke-*` prefix (or that names the business
 * namespace as an active target) must fail before it can touch anything.
 */
export function validateNaming(naming: SmokeNaming): readonly string[] {
  const problems: string[] = [];
  const check = (label: string, value: string): void => {
    if (!value.startsWith(SMOKE_PREFIX + '-') && !value.startsWith(SMOKE_PREFIX + '/')) {
      problems.push(label + ' "' + value + '" does not carry the ' + SMOKE_PREFIX + ' test prefix');
    }
  };
  for (const session of naming.sessionTags) {
    check('session tag', session);
    const branches = naming.branchTags[session];
    if (branches === undefined || branches.length < 2) {
      problems.push('session ' + session + ' must declare at least two sibling branch tags');
      continue;
    }
    for (const branch of branches) {
      check('branch tag', branch);
      if (!branch.startsWith(session + '-')) {
        problems.push('branch tag ' + branch + ' is not scoped to session ' + session);
      }
    }
  }
  check('primary namespace', naming.namespaces.primary);
  check('secondary namespace', naming.namespaces.secondary);
  if (naming.namespaces.primary === naming.namespaces.secondary) {
    problems.push('primary and secondary namespaces must differ (namespace isolation needs two)');
  }
  if (naming.namespaces.businessNamespace.startsWith(SMOKE_PREFIX)) {
    problems.push('businessNamespace must be a real (non-test) namespace, so "not touched" is meaningful');
  }
  return problems;
}
