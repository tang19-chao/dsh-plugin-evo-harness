/**
 * Deterministic JitRL action normalization (plan section 6.2, P1-1).
 *
 * Ownership: src/jitrl/** (Phase 1 kernel).
 *
 * Action keys are the memory's primary index for Q(s, a) and the tie-break key
 * for logit-adjuster's argmax, so they must be stable and instance-free:
 *
 *   L1  slot:<kind>[/surf:<sorted surfaces>]
 *   L2  <surface>:<editType>(<keyObject>) joined by '+', or 'noop'
 *   L3  tool:<name>[(<key>=<coarse shape>,...)]
 *
 * Everything is structural: no LLM, no timestamps, no ids, no branch names and
 * no concrete literals. Literals longer than 24 characters, values under
 * secret-looking argument keys, and anything matching a known credential shape
 * are replaced by 'redacted'. Command arguments keep only the leading command
 * name plus '*', e.g. 'cmd=pnpm*'.
 */

import {
  BATCH_SLOT_KINDS,
  HARNESS_COMPONENT_KEYS,
  type BatchSlotKind,
  type EightSurfacePatch,
  type GuardrailsSurfaceEdit,
  type HarnessComponentKey,
  type MemorySurfaceEdit,
  type PluginsSurfaceEdit,
  type ScriptsSurfaceEdit,
  type SkillsSurfaceEdit,
  type SubagentsSurfaceEdit,
  type SystemPromptSurfaceEdit,
  type ToolGuidanceSurfaceEdit
} from '../types/contracts';

/** Maximum literal length kept in an action key; longer values are redacted. */
export const MAX_ACTION_LITERAL = 24;

/** Argument keys whose values are never persisted. */
const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[-_]?key|auth(orization)?|credential|cookie|session)/i;

/** Argument keys whose string values are treated as shell commands. */
const COMMAND_KEY_PATTERN = /^(cmd|command|script|exec|executable|binary)$/i;

/** Literal shapes that must never enter a persisted action key. */
const SECRET_LITERAL_PATTERNS: readonly RegExp[] = [
  /\bbearer\s+[a-z0-9._~+/-]+/i,
  /\bsk-[a-z0-9_-]{8,}/i,
  /\bgh[pousr]_[a-z0-9]{16,}/i,
  /\bxox[abposr]-[a-z0-9-]{8,}/i,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\./i,
  /\b[0-9a-f]{32,}\b/i,
  /(api[-_]?key|password|secret|token)\s*[=:]\s*\S+/i
];

const OUTPUT_FORMATS = [
  'json',
  'table',
  'code',
  'report',
  'patch',
  'migration',
  'test'
] as const;

function slugToken(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '');
  return slug;
}

function looksSecretLiteral(value: string): boolean {
  return SECRET_LITERAL_PATTERNS.some((pattern) => pattern.test(value));
}

/** Safe structural identifier: lowercase slug, never a secret or long literal. */
function safeIdentifier(value: string, fallback = 'unknown'): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) {
    return fallback;
  }
  if (trimmed.length > MAX_ACTION_LITERAL || looksSecretLiteral(trimmed)) {
    return 'redacted';
  }
  const slug = slugToken(trimmed);
  return slug.length === 0 ? fallback : slug;
}

function clampIdentifier(value: string, maxLength = MAX_ACTION_LITERAL): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function detectFormatCategory(text: string): string {
  const lowered = text.toLowerCase();
  for (const format of OUTPUT_FORMATS) {
    if (new RegExp('\\b' + format + '\\b').test(lowered)) {
      return format;
    }
  }
  return 'contract';
}

function entry(
  surface: HarnessComponentKey,
  editType: string,
  keyObject: string
): string {
  return surface + ':' + editType + '(' + keyObject + ')';
}

function scriptStem(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return safeIdentifier(stem, 'script');
}

/**
 * L1 action key. Surfaces are sorted and deduped; no surfaces means the slot
 * alone. Invalid slot kinds or surface names are programmer errors.
 */
export function normalizeMetaAction(
  slot: BatchSlotKind,
  focusSurfaces: readonly HarnessComponentKey[]
): string {
  if (!(BATCH_SLOT_KINDS as readonly string[]).includes(slot)) {
    throw new RangeError('normalizeMetaAction: slot must be a BatchSlotKind');
  }
  const surfaces = new Set<HarnessComponentKey>();
  for (const surface of focusSurfaces) {
    if (!(HARNESS_COMPONENT_KEYS as readonly string[]).includes(surface)) {
      throw new RangeError(
        'normalizeMetaAction: unknown harness component ' + String(surface)
      );
    }
    surfaces.add(surface);
  }
  if (surfaces.size === 0) {
    return 'slot:' + slot;
  }
  return 'slot:' + slot + '/surf:' + [...surfaces].sort().join('+');
}

function surfaceEntries(
  surface: HarnessComponentKey,
  payload: unknown
): readonly string[] {
  switch (surface) {
    case 'system_prompt': {
      const edit = payload as SystemPromptSurfaceEdit;
      const mode = edit.mode === 'append' || edit.mode === 'replace' ? edit.mode : 'replace';
      return [entry('system_prompt', mode, safeIdentifier(edit.segment ?? 'default', 'default'))];
    }
    case 'guardrails': {
      const edit = payload as GuardrailsSurfaceEdit;
      const entries: string[] = [];
      for (const precondition of edit.toolPreconditions ?? []) {
        entries.push(
          entry('guardrails', 'precondition', safeIdentifier(precondition.toolName, 'tool'))
        );
      }
      if (typeof edit.formatContract === 'string' && edit.formatContract.trim().length > 0) {
        entries.push(entry('guardrails', 'format', detectFormatCategory(edit.formatContract)));
      }
      const appendCount = edit.appendRules?.length ?? 0;
      if (appendCount > 0) {
        entries.push(entry('guardrails', 'append', String(appendCount)));
      }
      const forbiddenCount = edit.forbiddenActions?.length ?? 0;
      if (forbiddenCount > 0) {
        entries.push(entry('guardrails', 'forbid', String(forbiddenCount)));
      }
      if (entries.length === 0) {
        entries.push(entry('guardrails', 'edit', 'rules'));
      }
      return entries;
    }
    case 'memory': {
      const edit = payload as MemorySurfaceEdit;
      const entries: string[] = [];
      if (edit.scopedViewId !== undefined) {
        // The view id is branch-specific; only its presence is structural.
        entries.push(entry('memory', 'scope', 'branch'));
      }
      const noteCount = edit.workingNotes?.length ?? 0;
      if (noteCount > 0) {
        entries.push(entry('memory', 'notes', String(noteCount)));
      }
      for (const tag of [...new Set(edit.recallTags ?? [])].sort()) {
        entries.push(entry('memory', 'tag', safeIdentifier(tag, 'tag')));
      }
      if (entries.length === 0) {
        entries.push(entry('memory', 'edit', 'none'));
      }
      return entries;
    }
    case 'tool_guidance': {
      const edit = payload as ToolGuidanceSurfaceEdit;
      const entries: string[] = [];
      for (const toolName of Object.keys(edit.descriptions ?? {}).sort()) {
        entries.push(entry('tool_guidance', 'rewrite', safeIdentifier(toolName, 'tool')));
      }
      for (const example of edit.examples ?? []) {
        entries.push(
          entry('tool_guidance', 'example', safeIdentifier(example.toolName, 'tool'))
        );
      }
      const priorityCount = edit.priorityOrder?.length ?? 0;
      if (priorityCount > 0) {
        entries.push(entry('tool_guidance', 'priority', String(priorityCount)));
      }
      if (entries.length === 0) {
        entries.push(entry('tool_guidance', 'edit', 'none'));
      }
      return entries;
    }
    case 'skills': {
      const edit = payload as SkillsSurfaceEdit;
      if ((edit.skills ?? []).length === 0) {
        return [entry('skills', 'edit', 'none')];
      }
      return (edit.skills ?? []).map((skill) =>
        entry('skills', 'mount', safeIdentifier(skill.name, 'skill'))
      );
    }
    case 'scripts': {
      const edit = payload as ScriptsSurfaceEdit;
      if ((edit.scripts ?? []).length === 0) {
        return [entry('scripts', 'edit', 'none')];
      }
      return (edit.scripts ?? []).map((script) =>
        entry('scripts', 'mount', scriptStem(script.path))
      );
    }
    case 'subagents': {
      const edit = payload as SubagentsSurfaceEdit;
      if ((edit.agents ?? []).length === 0) {
        return [entry('subagents', 'edit', 'none')];
      }
      return (edit.agents ?? []).map((agent) =>
        entry('subagents', 'register', safeIdentifier(agent.name, 'agent'))
      );
    }
    case 'plugins': {
      const edit = payload as PluginsSurfaceEdit;
      if ((edit.middleware ?? []).length === 0) {
        return [entry('plugins', 'edit', 'none')];
      }
      return (edit.middleware ?? []).map((middleware) => {
        const hook =
          middleware.hook === 'before_tool' ||
          middleware.hook === 'after_tool' ||
          middleware.hook === 'around_tool'
            ? middleware.hook
            : 'around_tool';
        return entry(
          'plugins',
          'middleware',
          hook + ':' + safeIdentifier(middleware.name, 'middleware')
        );
      });
    }
    default:
      return [];
  }
}

/**
 * L2 patch signature. Only the structural edit types and key objects are
 * encoded; patch ids, branch ids, session ids, rationale and timestamps are
 * deliberately ignored so the same semantic patch yields the same key.
 * An empty patch is 'noop'.
 */
export function normalizePatchSignature(patch: EightSurfacePatch): string {
  const edits = patch?.edits;
  if (edits === undefined || edits === null || typeof edits !== 'object') {
    return 'noop';
  }
  const entries: string[] = [];
  for (const surface of HARNESS_COMPONENT_KEYS) {
    const payload = edits[surface];
    if (payload === undefined) {
      continue;
    }
    entries.push(...surfaceEntries(surface, payload));
  }
  const unique = [...new Set(entries)].sort();
  return unique.length === 0 ? 'noop' : unique.join('+');
}

function commandHead(value: string): string {
  const first = value.trim().split(/\s+/)[0] ?? '';
  if (first.length === 0) {
    return 'empty';
  }
  if (looksSecretLiteral(first)) {
    return 'redacted*';
  }
  const normalized = first.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const slug = slugToken(stem);
  if (slug.length === 0) {
    return 'empty';
  }
  return clampIdentifier(slug) + '*';
}

function argumentShape(value: unknown, key: string): string {
  if (SECRET_KEY_PATTERN.test(key)) {
    return 'redacted';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return '[...]';
  }
  switch (typeof value) {
    case 'string': {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return 'empty';
      }
      if (looksSecretLiteral(trimmed)) {
        return 'redacted';
      }
      if (COMMAND_KEY_PATTERN.test(key)) {
        return commandHead(trimmed);
      }
      // Generic strings are concrete literals; keep only their shape.
      return 'str';
    }
    case 'number':
    case 'bigint':
      return '#';
    case 'boolean':
      return 'bool';
    case 'object':
      return '{...}';
    default:
      return 'unknown';
  }
}

function argumentKey(key: string): string {
  const cleaned = key.replace(/[^a-zA-Z0-9_.-]+/g, '');
  if (cleaned.length === 0) {
    return 'arg';
  }
  return clampIdentifier(cleaned);
}

function describeInput(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length === 0) {
      return 'arg={...}';
    }
    return keys
      .slice(0, 6)
      .map((key) => argumentKey(key) + '=' + argumentShape(record[key], key))
      .join(',');
  }
  return 'arg=' + argumentShape(input, 'arg');
}

/**
 * L3 tool-call action key: tool name plus a coarse argument shape. Concrete
 * values are never stored; commands keep only their leading name plus '*'.
 */
export function normalizeToolActionKey(toolName: string, input?: unknown): string {
  const name = safeIdentifier(toolName, 'unknown');
  const shape = describeInput(input);
  return shape === null ? 'tool:' + name : 'tool:' + name + '(' + shape + ')';
}
