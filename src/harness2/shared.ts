/**
 * Internal deterministic helpers shared by the Harness² modules
 * (proposer.ts, composer.ts, reflector.ts).
 *
 * Ownership: src/harness2/** (Wave 1, Harness² track). This module imports the
 * frozen contract surface only (src/types/contracts.ts) and never reaches into
 * cordis-seams, memory-bridge or dream-rsi, so the Harness² unit tests run
 * without host, MCP, sandbox or LLM access.
 *
 * Every effect that could make a unit test non-deterministic (wall clock, id
 * generation, the model adapter) is injected by the caller. Everything here is
 * a pure function over plain contract records.
 */

import {
  HARNESS_COMPONENT_KEYS,
  type HarnessComponentKey,
  type ProbeTrajectory,
  type TrajectoryDeliverable,
  type TrajectoryStep
} from '../types/contracts';

/** Injected time source (UTC epoch milliseconds). */
export type Clock = () => number;

/** Default wall clock; inject a fixed clock in tests. */
export const systemClock: Clock = () => Date.now();

/** Injected opaque id factory. Ids are never parsed for meaning. */
export type IdFactory = (prefix: string) => string;

/**
 * Counter-based id factory. Deterministic per instance, which is what unit
 * tests, snapshot comparison and offline replay need. Production callers may
 * inject a uuid/ulid factory instead.
 */
export function createDeterministicIdFactory(seed: string = 'h2'): IdFactory {
  let counter = 0;
  return (prefix: string): string => {
    counter += 1;
    return seed + '_' + prefix + '_' + counter;
  };
}

/** Clamp a finite number into [min, max]; non-finite input yields min. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/** Clamp into [0, 1]. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** True for non-null, non-array objects (JSON object shape). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-empty trimmed string or undefined. */
export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.trim().length > 0 ? value : undefined;
}

/** Finite number or undefined. */
export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Strict string-array reader: undefined unless every entry is a non-empty string. */
export function readStringList(value: unknown, max: number = 64): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    const text = nonEmptyString(item);
    if (text === undefined) {
      return undefined;
    }
    if (!out.includes(text)) {
      out.push(text);
    }
    if (out.length > max) {
      return undefined;
    }
  }
  return out;
}

/** Stable 32-bit FNV-1a hash rendered as 8 hex chars. */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Truncate long text with an ellipsis marker, never longer than max. */
export function truncate(text: string, max: number): string {
  if (max <= 0) {
    return '';
  }
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max - 1) + '\u2026';
}

/** Collapse whitespace so prompt dossiers stay one-line readable. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue(value[key]);
    }
    return out;
  }
  return value;
}

/** JSON stringify with recursively sorted keys (stable across call sites). */
export function stableStringify(value: unknown): string {
  const json = JSON.stringify(sortValue(value));
  return json === undefined ? 'undefined' : json;
}

/** Compact deterministic summary of one surface payload (for lesson diffs). */
export function surfaceEditSummary(payload: unknown, max: number = 400): string {
  return truncate(stableStringify(payload), max);
}

/** Contract-ordered subset of the eight surfaces. */
export function surfaceKeysInOrder(keys: Iterable<string>): HarnessComponentKey[] {
  const wanted = new Set<string>(keys);
  const out: HarnessComponentKey[] = [];
  for (const key of HARNESS_COMPONENT_KEYS) {
    if (wanted.has(key)) {
      out.push(key);
    }
  }
  return out;
}

/** True when the value is one of the eight harness surface keys. */
export function isSurfaceKey(value: unknown): value is HarnessComponentKey {
  return typeof value === 'string' && (HARNESS_COMPONENT_KEYS as readonly string[]).includes(value);
}

/**
 * Pattern matching structured JitRL advice blocks injected into host tools or observations.
 * Matches both standard <jitrl_advice>...</jitrl_advice> and <anti_patterns_to_avoid> tags.
 */
const STRUCTURED_ADVICE_PATTERN =
  /<(?:jitrl_advice|anti_patterns_to_avoid)(?:\s+[^>]*)?>[\s\S]*?<\/(?:jitrl_advice|anti_patterns_to_avoid)>|<(?:jitrl_advice|anti_patterns_to_avoid)(?:\s+[^>]*)?\/>/gi;

/**
 * Strip structured JitRL advisory markup from text before entering judge/composer prompts.
 *
 * GOVERNANCE & RISK NOTICE (L2 repair):
 * Stripping XML tags removes explicit structured advice markup. However, if a model
 * restates or paraphrases advisory statistics (e.g. mean return, neighbor counts, anti-patterns)
 * in free-form prose, XML tag stripping alone CANNOT eliminate those semantic restatements.
 * This residual risk is explicitly audited and recorded rather than claimed eliminated.
 */
export function stripStructuredAdvice(text: string): string {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }
  return text.replace(STRUCTURED_ADVICE_PATTERN, '').trim();
}

/** Deterministic per-step summary used by the anonymous judge dossier. */
export function summarizeTrajectorySteps(
  steps: readonly TrajectoryStep[],
  limit: number = 10
): string[] {
  const sorted = [...steps].sort((left, right) => left.index - right.index);
  const out: string[] = [];
  for (const step of sorted.slice(0, Math.max(0, limit))) {
    const parts: string[] = ['#' + step.index, step.kind];
    if (step.toolName !== undefined) {
      parts.push(step.toolName);
    }
    if (step.error !== undefined) {
      const cleanedError = stripStructuredAdvice(step.error.message);
      parts.push('error=' + truncate(oneLine(cleanedError), 80));
    } else if (step.text !== undefined) {
      const cleanedText = stripStructuredAdvice(step.text);
      if (cleanedText.length > 0) {
        parts.push(truncate(oneLine(cleanedText), 80));
      }
    }
    out.push(parts.join(' '));
  }
  if (sorted.length > limit) {
    out.push('(+' + (sorted.length - limit) + ' more steps)');
  }
  return out;
}

/**
 * Deliverable of a trajectory with a filled contentHash. A run that produced
 * nothing keeps an explicit placeholder so the judge never sees an empty
 * document that could be mistaken for a winning deliverable.
 */
export function deliverableOf(trajectory: ProbeTrajectory): TrajectoryDeliverable {
  const deliverable = trajectory.deliverable;
  if (deliverable === undefined) {
    return { content: '(no deliverable produced)', format: 'text', contentHash: hashString('') };
  }
  if (deliverable.contentHash !== undefined) {
    return deliverable;
  }
  return { ...deliverable, contentHash: hashString(deliverable.content) };
}

/** Replace known opaque identifiers with a redaction marker. */
export function redactIdentifiers(text: string, identifiers: readonly string[]): string {
  let out = text;
  for (const identifier of identifiers) {
    if (identifier.length === 0) {
      continue;
    }
    out = out.split(identifier).join('[redacted]');
  }
  return out;
}

/** Balanced-brace JSON slice starting at an opening brace/bracket. */
function balancedSlice(text: string, start: number): string | undefined {
  const open = text[start];
  if (open !== '{' && open !== '[') {
    return undefined;
  }
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

/**
 * Extract the first JSON object/array from a model response. Handles raw JSON,
 * fenced code blocks and prose around one JSON value. Returns undefined when
 * nothing parses, so callers can fail fast instead of guessing.
 */
export function extractJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const fence = String.fromCharCode(96).repeat(3);
  let body = trimmed;
  const fenceStart = trimmed.indexOf(fence);
  if (fenceStart >= 0) {
    const afterFence = trimmed.indexOf(fence, fenceStart + fence.length);
    if (afterFence > fenceStart) {
      const inner = trimmed.slice(fenceStart + fence.length, afterFence).trim();
      body = inner.startsWith('json') ? inner.slice(4).trim() : inner;
    }
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // fall through to the balanced scan below
  }
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '{' && char !== '[') {
      continue;
    }
    const slice = balancedSlice(body, index);
    if (slice === undefined) {
      continue;
    }
    try {
      return JSON.parse(slice) as unknown;
    } catch {
      // keep scanning for the next plausible JSON value
    }
  }
  return undefined;
}
