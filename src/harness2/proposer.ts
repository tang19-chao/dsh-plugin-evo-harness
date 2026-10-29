/**
 * Harness² dual-track proposer: Domain (memory-guided) vs Invariant
 * (guidance-free first-principles exploration).
 *
 * ARCHITECTURE.md §3 (eight reversible surfaces) and §5.1 (asymmetric memory
 * injection). The proposer is a pure prompt builder plus a strict JSON parser:
 * the model adapter is injected (IModelAdapter) so unit tests are deterministic
 * and every proposal is a plain EightSurfacePatch record.
 *
 * Asymmetry guarantees enforced here (not merely requested in the prompt):
 * 1. A guidance-free slot NEVER renders recalled lesson content into the model
 *    request, even when the caller passes domain guidance by mistake.
 * 2. A guidance-free patch NEVER carries sourceLessonIds or memoryRecallIds.
 * 3. recallTags on a memory-surface edit are stripped for guidance-free
 *    branches, because they would pull external memory into the probe run.
 */

import {
  HARNESS_COMPONENT_KEYS,
  type ContractMetadata,
  type DynamicSkillSpec,
  type EightSurfaceEdits,
  type EightSurfacePatch,
  type GuardrailsSurfaceEdit,
  type HarnessComponentKey,
  type IHarnessProposer,
  type IModelAdapter,
  type MemoryRecallResult,
  type MemorySurfaceEdit,
  type MiddlewareSpec,
  type ModelMessage,
  type ModelRequest,
  type PatchPurpose,
  type PluginsSurfaceEdit,
  type ProbeTrajectory,
  type ProposeRequest,
  type ProposedPatch,
  type ProposedPatchSet,
  type ScriptArtifactSpec,
  type ScriptsSurfaceEdit,
  type SkillsSurfaceEdit,
  type SubagentSpec,
  type SubagentsSurfaceEdit,
  type SupportedSurfacePayload,
  type SystemPromptSurfaceEdit,
  type ToolGuidanceSurfaceEdit,
  type ToolPrecondition
} from '../types/contracts';
// P3-B: every model call leaves this module through the unified metered boundary.
import { createMeteredModelAdapter, type MeteredModelOptions } from '../dsh-bridge/metered-model-adapter';
import {
  type Clock,
  type IdFactory,
  clamp01,
  createDeterministicIdFactory,
  extractJsonValue,
  finiteNumber,
  isRecord,
  isSurfaceKey,
  nonEmptyString,
  oneLine,
  readStringList,
  systemClock,
  surfaceKeysInOrder,
  truncate
} from './shared';

/** Injectable dependencies of the Harness² proposer. */
export interface HarnessProposerOptions {
  /** Host-neutral LLM boundary. Required: proposals are model-authored. */
  readonly model: IModelAdapter;
  /** P3-B metering wiring (ledger/registry); absent records calls without cost. */
  readonly metering?: MeteredModelOptions;
  /** Injected clock; defaults to Date.now(). */
  readonly now?: Clock;
  /** Injected id factory; defaults to a deterministic counter. */
  readonly newId?: IdFactory;
  /** Cap on lessons rendered per prompt section. Defaults to 8. */
  readonly maxLessonsPerSection?: number;
  /** Sampling temperature; defaults to 0.2 (low for reproducibility). */
  readonly temperature?: number;
  /** Response token cap; defaults to 2048. */
  readonly maxTokens?: number;
}

/** Failure modes of one proposal attempt. */
export type Harness2ProposalFailure = 'proposal_unparseable' | 'proposal_no_valid_edits';

/** Deterministic typed failure raised by the proposer. */
export class Harness2ProposalError extends Error {
  readonly code: Harness2ProposalFailure;
  readonly detail: string;

  constructor(code: Harness2ProposalFailure, message: string, detail: string) {
    super(message);
    this.name = 'Harness2ProposalError';
    this.code = code;
    this.detail = detail;
  }
}

/** Resolved guidance decision for one proposal. */
export interface ProposalGuidanceDecision {
  readonly memoryAllowed: boolean;
  readonly sanitized: boolean;
  readonly reason: string;
}

/**
 * Decide whether external memory may reach this proposal. Invariant slots and
 * guidance-free slots always lose memory access; a domain guidance object that
 * arrives on such a slot is reported as sanitized instead of being trusted.
 */
export function decideProposalGuidance(request: ProposeRequest): ProposalGuidanceDecision {
  const invariantSlot = request.slot.slot === 'explore_invariant';
  const slotGuidanceFree = request.slot.guidance === 'guidance_free';
  const memoryRequested = request.guidance.mode === 'domain';
  const memoryAllowed = memoryRequested && !invariantSlot && !slotGuidanceFree;
  if (memoryRequested && !memoryAllowed) {
    return {
      memoryAllowed: false,
      sanitized: true,
      reason:
        'domain memory was stripped: slot ' +
        request.slot.slot +
        ' is a guidance-free (invariant) exploration branch and must not receive external memory'
    };
  }
  if (!memoryRequested) {
    return {
      memoryAllowed: false,
      sanitized: false,
      reason: 'invariant guidance object carries memory: null by construction'
    };
  }
  return { memoryAllowed: true, sanitized: false, reason: 'domain guidance with recalled lessons' };
}

const SURFACE_PAYLOAD_CONTRACT: readonly string[] = [
  '- system_prompt: { "kind": "system_prompt", "mode": "append"|"replace", "content": string, "segment"?: string, "priority"?: number }',
  '- guardrails: { "kind": "guardrails", "appendRules"?: string[], "forbiddenActions"?: string[], "formatContract"?: string, "toolPreconditions"?: [{"toolName": string, "rule": string}] } (at least one field)',
  '- memory: { "kind": "memory", "scopedViewId"?: string, "workingNotes"?: string[], "recallTags"?: string[] } (at least one field)',
  '- tool_guidance: { "kind": "tool_guidance", "descriptions": {"<tool>": string}, "priorityOrder"?: string[], "examples"?: [{"toolName": string, "example": string}] }',
  '- skills: { "kind": "skills", "skills": [{"name": string, "markdown": string, "description"?: string, "activate"?: boolean}] }',
  '- scripts: { "kind": "scripts", "scripts": [{"path": string, "language": "python"|"bash"|"typescript"|"javascript", "code": string, "executable"?: boolean}] }',
  '- subagents: { "kind": "subagents", "agents": [{"name": string, "description": string, "systemPrompt"?: string, "tools"?: string[], "model"?: string}] }',
  '- plugins: { "kind": "plugins", "middleware": [{"name": string, "hook": "before_tool"|"after_tool"|"around_tool", "language": "typescript"|"javascript", "code": string, "description"?: string}] }'
];

function referenceRunLines(reference: ProbeTrajectory): string[] {
  const lines: string[] = [];
  lines.push('status: ' + reference.status);
  lines.push(
    'metrics: steps=' +
      reference.metrics.steps +
      ' toolCalls=' +
      reference.metrics.toolCalls +
      ' toolErrors=' +
      reference.metrics.toolErrors +
      ' durationMs=' +
      reference.metrics.durationMs
  );
  if (reference.surfaceKeys.length > 0) {
    lines.push('patchedSurfaces: ' + reference.surfaceKeys.join(', '));
  }
  if (reference.error !== undefined) {
    lines.push('error: ' + reference.error.name + ': ' + truncate(oneLine(reference.error.message), 240));
  }
  for (const signal of reference.failureSignals.slice(0, 6)) {
    lines.push('failureSignal: ' + signal.kind + ' -> ' + truncate(oneLine(signal.message), 200));
  }
  for (const toolError of reference.toolErrors.slice(0, 5)) {
    lines.push('toolError: ' + toolError.toolName + ': ' + truncate(oneLine(toolError.message), 160));
  }
  if (reference.deliverable !== undefined) {
    lines.push('deliverableChars: ' + reference.deliverable.content.length);
  }
  return lines;
}

function memorySectionLines(recall: MemoryRecallResult, maxLessons: number): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push('## Recalled memory (domain guidance)');
  lines.push(
    'driver: ' +
      recall.driverKind +
      ' | confidence: ' +
      recall.confidence +
      ' | degraded: ' +
      String(recall.degraded)
  );
  const positives = recall.positiveLessons.slice(0, maxLessons);
  if (positives.length === 0) {
    lines.push('positive_lessons: none recalled for this task.');
  } else {
    lines.push('### positive_lessons (recommendations to adapt, never to copy literally)');
    for (const lesson of positives) {
      lines.push('- [' + lesson.id + '] ' + lesson.title);
      lines.push('  whenToApply: ' + lesson.whenToApply.join(' | '));
      lines.push('  whenNotToApply: ' + lesson.whenNotToApply.join(' | '));
      lines.push('  components: ' + lesson.subFunctions.join(', '));
      lines.push('  execution: ' + truncate(oneLine(lesson.executionPatch.summary), 240));
    }
  }
  const negatives = recall.negativeLessons.slice(0, maxLessons);
  if (negatives.length === 0) {
    lines.push('anti_patterns_to_avoid: none recalled for this task.');
  } else {
    lines.push('### <anti_patterns_to_avoid> (observed failures; warnings only, NEVER recommendations)');
    for (const lesson of negatives) {
      lines.push('- [' + lesson.id + '] ' + lesson.title);
      lines.push('  failedWhen: ' + lesson.whenToApply.join(' | '));
      lines.push('  evidence: ' + truncate(oneLine(lesson.verificationEvidence.referenceFailure), 200));
    }
  }
  if (recall.suppressedLessons.length > 0) {
    lines.push(
      'withheld_by_firewall: ' +
        recall.suppressedLessons
          .slice(0, 5)
          .map((suppressed) => suppressed.title + ' (' + suppressed.reason + ')')
          .join('; ')
    );
  }
  return lines;
}

/**
 * Render the exact model messages for one proposal. Exported so tests and
 * reviewers can assert the asymmetric memory policy without a live model.
 */
export function renderProposalPrompts(
  request: ProposeRequest,
  options?: { readonly maxLessonsPerSection?: number; readonly candidateCount?: number }
): readonly ModelMessage[] {
  const decision = decideProposalGuidance(request);
  const maxLessons = options?.maxLessonsPerSection ?? 8;
  const recall: MemoryRecallResult | undefined =
    decision.memoryAllowed && request.guidance.mode === 'domain' ? request.guidance.memory : undefined;

  const system: string[] = [];
  system.push('You are the Harness² proposer for a DeepSeek Harness (Cordis) agent.');
  system.push(
    'You edit the eight harness surfaces that wrap a frozen model. Model weights never change; only the scaffold around them changes.'
  );
  system.push('Surfaces (stable order): ' + HARNESS_COMPONENT_KEYS.join(', ') + '.');
  const shapeLine =
    '{ "rationale": string, "focusSurfaces": string[], "confidence": number in [0,1], "expectedStepsDelta": number, "edits": { <surface>: <payload> } }';
  const candidateCount = options?.candidateCount ?? 1;
  if (candidateCount > 1) {
    system.push(
      'Return a JSON ARRAY of exactly ' + String(candidateCount) + ' candidate objects, no prose. Every array element matches this shape:'
    );
    system.push(shapeLine);
    system.push('Diversify: every candidate must propose a materially different edit plan; never repeat an object.');
  } else {
    system.push('Return exactly ONE JSON object, no prose, matching this shape:');
    system.push(shapeLine);
  }
  system.push('Payload shapes (the "kind" field is mandatory):');
  for (const line of SURFACE_PAYLOAD_CONTRACT) {
    system.push(line);
  }
  system.push(
    'Rules: only edit surfaces listed as allowed; keep each edit minimal and directly testable; never invent tool names or files that the task did not mention.'
  );
  if (decision.memoryAllowed) {
    system.push(
      'Memory policy: DOMAIN branch. Recalled positive lessons are recommendations to adapt; negative lessons are anti-patterns that must never be applied as recommendations.'
    );
  } else {
    system.push(
      'Memory policy: GUIDANCE-FREE branch (first-principles / invariant exploration). External memory is disabled: no recalled lesson is available, none may be assumed, and no lesson id may appear anywhere in your output.'
    );
  }

  const user: string[] = [];
  user.push('## Task');
  user.push('prompt: ' + truncate(oneLine(request.task.prompt), 1200));
  if (request.task.taskSignature !== undefined) {
    user.push('taskSignature: ' + request.task.taskSignature);
  }
  if (request.task.complexity !== undefined) {
    user.push('complexity: ' + request.task.complexity);
  }
  const contextTags = request.task.contextTags ?? [];
  if (contextTags.length > 0) {
    user.push('contextTags: ' + contextTags.join(', '));
  }
  user.push('');
  user.push('## Slot');
  user.push('slot: ' + request.slot.slot + ' (index ' + request.slot.slotIndex + ')');
  user.push(
    'origin: ' +
      request.slot.origin +
      ' | guidance: ' +
      request.slot.guidance +
      ' | attempt ' +
      request.attemptIndex +
      ' of ' +
      request.totalBudget
  );
  user.push(
    'focusSurfaces: ' +
      (request.slot.focusSurfaces.length > 0 ? request.slot.focusSurfaces.join(', ') : '(proposer choice)')
  );
  user.push('slotRationale: ' + truncate(oneLine(request.slot.rationale), 400));
  if (request.slot.expectedUtility !== undefined) {
    user.push('expectedUtility: ' + request.slot.expectedUtility);
  }
  if (request.enabledSurfaces !== undefined) {
    user.push('allowedSurfaces: ' + request.enabledSurfaces.join(', '));
  }
  if (request.slot.repairOfNodeId !== undefined) {
    user.push('repairOfNodeId: ' + request.slot.repairOfNodeId + ' (repair, do not redesign from scratch)');
  }
  if (decision.memoryAllowed && request.slot.memoryHintIds !== undefined && request.slot.memoryHintIds.length > 0) {
    user.push('memoryHintIds: ' + request.slot.memoryHintIds.join(', '));
  }

  if (request.parentPatch !== undefined) {
    user.push('');
    user.push('## Parent patch');
    user.push('label: ' + request.parentPatch.label);
    user.push('origin: ' + request.parentPatch.origin + ' | purpose: ' + request.parentPatch.purpose);
    user.push('rationale: ' + truncate(oneLine(request.parentPatch.rationale), 400));
    user.push('editedSurfaces: ' + Object.keys(request.parentPatch.edits).join(', '));
  }
  if (request.parentNode !== undefined) {
    user.push('');
    user.push('## Parent node');
    user.push(
      'id: ' +
        request.parentNode.id +
        ' | status: ' +
        request.parentNode.status +
        ' | depth: ' +
        request.parentNode.depth
    );
    if (request.parentNode.score !== undefined) {
      user.push('score: ' + request.parentNode.score);
    }
    if (request.parentNode.failure !== undefined) {
      user.push(
        'failure: ' +
          request.parentNode.failure.category +
          ' -> ' +
          request.parentNode.failure.recommendedAction +
          (request.parentNode.failure.repairHint !== undefined
            ? ' | repairHint: ' + truncate(oneLine(request.parentNode.failure.repairHint), 200)
            : '')
      );
    }
  }
  const reference = request.referenceTrajectory;
  if (reference !== undefined) {
    user.push('');
    user.push('## Reference run (contrast baseline)');
    for (const line of referenceRunLines(reference)) {
      user.push(line);
    }
  } else {
    user.push('');
    user.push('## Reference run');
    user.push('none available; propose from the task statement alone.');
  }

  if (decision.memoryAllowed && recall !== undefined) {
    for (const line of memorySectionLines(recall, maxLessons)) {
      user.push(line);
    }
  } else {
    user.push('');
    user.push('## Memory policy');
    user.push(
      'External memory is DISABLED for this branch (guidance-free invariant exploration). No recalled lessons are available and none may be assumed; derive improvements only from the task statement and the reference-run evidence.'
    );
  }

  user.push('');
  user.push('## Output');
  user.push('Return the single JSON proposal object now.');

  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: user.join('\n') }
  ];
}

/** Map a Dream-RSI batch slot onto the patch purpose recorded on the patch. */
export function purposeForSlot(slot: ProposeRequest['slot']['slot']): PatchPurpose {
  switch (slot) {
    case 'exploit':
      return 'deepen';
    case 'recover':
      return 'repair';
    case 'explore_domain':
    case 'explore_invariant':
      return 'explore';
    default:
      return 'explore';
  }
}

type ValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function invalid<T>(reason: string): ValidationResult<T> {
  return { ok: false, reason };
}

function validateSystemPrompt(payload: Record<string, unknown>): ValidationResult<SystemPromptSurfaceEdit> {
  const mode = payload.mode === 'append' || payload.mode === 'replace' ? payload.mode : undefined;
  if (mode === undefined) {
    return invalid('mode must be "append" or "replace"');
  }
  const content = nonEmptyString(payload.content);
  if (content === undefined) {
    return invalid('content must be a non-empty string');
  }
  return valid({
    kind: 'system_prompt',
    mode,
    content,
    segment: nonEmptyString(payload.segment),
    priority: finiteNumber(payload.priority)
  });
}

function validateGuardrails(payload: Record<string, unknown>): ValidationResult<GuardrailsSurfaceEdit> {
  const appendRules = readStringList(payload.appendRules, 64);
  if (payload.appendRules !== undefined && appendRules === undefined) {
    return invalid('appendRules must be an array of non-empty strings');
  }
  const forbiddenActions = readStringList(payload.forbiddenActions, 64);
  if (payload.forbiddenActions !== undefined && forbiddenActions === undefined) {
    return invalid('forbiddenActions must be an array of non-empty strings');
  }
  let formatContract: string | undefined;
  if (payload.formatContract !== undefined) {
    formatContract = nonEmptyString(payload.formatContract);
    if (formatContract === undefined) {
      return invalid('formatContract must be a non-empty string');
    }
  }
  let toolPreconditions: ToolPrecondition[] | undefined;
  if (payload.toolPreconditions !== undefined) {
    if (!Array.isArray(payload.toolPreconditions)) {
      return invalid('toolPreconditions must be an array');
    }
    const rules: ToolPrecondition[] = [];
    for (const item of payload.toolPreconditions) {
      if (!isRecord(item)) {
        return invalid('each toolPrecondition must be an object');
      }
      const toolName = nonEmptyString(item.toolName);
      const rule = nonEmptyString(item.rule);
      if (toolName === undefined || rule === undefined) {
        return invalid('each toolPrecondition needs a non-empty toolName and rule');
      }
      rules.push({ toolName, rule });
    }
    toolPreconditions = rules;
  }
  if (
    appendRules === undefined &&
    forbiddenActions === undefined &&
    formatContract === undefined &&
    toolPreconditions === undefined
  ) {
    return invalid('at least one guardrails field is required');
  }
  return valid({ kind: 'guardrails', appendRules, forbiddenActions, formatContract, toolPreconditions });
}

function validateMemorySurface(payload: Record<string, unknown>): ValidationResult<MemorySurfaceEdit> {
  const scopedViewId = nonEmptyString(payload.scopedViewId);
  if (payload.scopedViewId !== undefined && scopedViewId === undefined) {
    return invalid('scopedViewId must be a non-empty string');
  }
  const workingNotes = readStringList(payload.workingNotes, 32);
  if (payload.workingNotes !== undefined && workingNotes === undefined) {
    return invalid('workingNotes must be an array of non-empty strings');
  }
  const recallTags = readStringList(payload.recallTags, 32);
  if (payload.recallTags !== undefined && recallTags === undefined) {
    return invalid('recallTags must be an array of non-empty strings');
  }
  if (scopedViewId === undefined && workingNotes === undefined && recallTags === undefined) {
    return invalid('at least one memory field is required');
  }
  return valid({ kind: 'memory', scopedViewId, workingNotes, recallTags });
}

function validateToolGuidance(payload: Record<string, unknown>): ValidationResult<ToolGuidanceSurfaceEdit> {
  if (!isRecord(payload.descriptions)) {
    return invalid('descriptions must be an object of tool name -> description');
  }
  const descriptions: Record<string, string> = {};
  for (const key of Object.keys(payload.descriptions)) {
    const text = nonEmptyString(payload.descriptions[key]);
    if (text === undefined) {
      return invalid('descriptions values must be non-empty strings');
    }
    descriptions[key] = text;
  }
  if (Object.keys(descriptions).length === 0) {
    return invalid('descriptions must contain at least one tool');
  }
  const priorityOrder = readStringList(payload.priorityOrder, 32);
  if (payload.priorityOrder !== undefined && priorityOrder === undefined) {
    return invalid('priorityOrder must be an array of non-empty strings');
  }
  let examples: Array<{ toolName: string; example: string }> | undefined;
  if (payload.examples !== undefined) {
    if (!Array.isArray(payload.examples)) {
      return invalid('examples must be an array');
    }
    const parsed: Array<{ toolName: string; example: string }> = [];
    for (const item of payload.examples) {
      if (!isRecord(item)) {
        return invalid('each example must be an object');
      }
      const toolName = nonEmptyString(item.toolName);
      const example = nonEmptyString(item.example);
      if (toolName === undefined || example === undefined) {
        return invalid('each example needs a non-empty toolName and example');
      }
      parsed.push({ toolName, example });
    }
    examples = parsed;
  }
  return valid({ kind: 'tool_guidance', descriptions, priorityOrder, examples });
}

function validateSkills(payload: Record<string, unknown>): ValidationResult<SkillsSurfaceEdit> {
  if (!Array.isArray(payload.skills) || payload.skills.length === 0) {
    return invalid('skills must be a non-empty array');
  }
  const skills: DynamicSkillSpec[] = [];
  for (const item of payload.skills) {
    if (!isRecord(item)) {
      return invalid('each skill must be an object');
    }
    const name = nonEmptyString(item.name);
    const markdown = typeof item.markdown === 'string' && item.markdown.trim().length > 0 ? item.markdown : undefined;
    if (name === undefined || markdown === undefined) {
      return invalid('each skill needs a non-empty name and markdown');
    }
    skills.push({ name, markdown, description: nonEmptyString(item.description), activate: item.activate === true });
  }
  return valid({ kind: 'skills', skills });
}

function validateScripts(payload: Record<string, unknown>): ValidationResult<ScriptsSurfaceEdit> {
  if (!Array.isArray(payload.scripts) || payload.scripts.length === 0) {
    return invalid('scripts must be a non-empty array');
  }
  const languages = ['python', 'bash', 'typescript', 'javascript'] as const;
  const scripts: ScriptArtifactSpec[] = [];
  for (const item of payload.scripts) {
    if (!isRecord(item)) {
      return invalid('each script must be an object');
    }
    const path = nonEmptyString(item.path);
    const code = typeof item.code === 'string' && item.code.trim().length > 0 ? item.code : undefined;
    const language = languages.find((candidate) => candidate === item.language);
    if (path === undefined || code === undefined || language === undefined) {
      return invalid('each script needs a non-empty path, a supported language and non-empty code');
    }
    scripts.push({ path, language, code, executable: item.executable === true });
  }
  return valid({ kind: 'scripts', scripts });
}

function validateSubagents(payload: Record<string, unknown>): ValidationResult<SubagentsSurfaceEdit> {
  if (!Array.isArray(payload.agents) || payload.agents.length === 0) {
    return invalid('agents must be a non-empty array');
  }
  const agents: SubagentSpec[] = [];
  for (const item of payload.agents) {
    if (!isRecord(item)) {
      return invalid('each subagent must be an object');
    }
    const name = nonEmptyString(item.name);
    const description = nonEmptyString(item.description);
    if (name === undefined || description === undefined) {
      return invalid('each subagent needs a non-empty name and description');
    }
    let systemPrompt: string | undefined;
    if (item.systemPrompt !== undefined) {
      systemPrompt = nonEmptyString(item.systemPrompt);
      if (systemPrompt === undefined) {
        return invalid('subagent.systemPrompt must be a non-empty string when present');
      }
    }
    const tools = readStringList(item.tools, 32);
    if (item.tools !== undefined && tools === undefined) {
      return invalid('subagent.tools must be an array of non-empty strings');
    }
    agents.push({ name, description, systemPrompt, tools, model: nonEmptyString(item.model) });
  }
  return valid({ kind: 'subagents', agents });
}

function validatePlugins(payload: Record<string, unknown>): ValidationResult<PluginsSurfaceEdit> {
  if (!Array.isArray(payload.middleware) || payload.middleware.length === 0) {
    return invalid('middleware must be a non-empty array');
  }
  const hooks = ['before_tool', 'after_tool', 'around_tool'] as const;
  const languages = ['typescript', 'javascript'] as const;
  const middleware: MiddlewareSpec[] = [];
  for (const item of payload.middleware) {
    if (!isRecord(item)) {
      return invalid('each middleware must be an object');
    }
    const name = nonEmptyString(item.name);
    const hook = hooks.find((candidate) => candidate === item.hook);
    const language = languages.find((candidate) => candidate === item.language);
    const code = typeof item.code === 'string' && item.code.trim().length > 0 ? item.code : undefined;
    if (name === undefined || hook === undefined || language === undefined || code === undefined) {
      return invalid('each middleware needs name, a supported hook/language and non-empty code');
    }
    middleware.push({ name, hook, language, code, description: nonEmptyString(item.description) });
  }
  return valid({ kind: 'plugins', middleware });
}

function validateSurfacePayload(
  key: HarnessComponentKey,
  payload: Record<string, unknown>
): ValidationResult<SupportedSurfacePayload> {
  switch (key) {
    case 'system_prompt':
      return validateSystemPrompt(payload);
    case 'guardrails':
      return validateGuardrails(payload);
    case 'memory':
      return validateMemorySurface(payload);
    case 'tool_guidance':
      return validateToolGuidance(payload);
    case 'skills':
      return validateSkills(payload);
    case 'scripts':
      return validateScripts(payload);
    case 'subagents':
      return validateSubagents(payload);
    case 'plugins':
      return validatePlugins(payload);
    default:
      return invalid('unsupported harness surface');
  }
}

function parseEdits(
  raw: unknown,
  allowed: readonly HarnessComponentKey[],
  dropped: string[]
): Partial<Record<HarnessComponentKey, SupportedSurfacePayload>> {
  const edits: Partial<Record<HarnessComponentKey, SupportedSurfacePayload>> = {};
  if (!isRecord(raw)) {
    dropped.push('edits: missing or not a JSON object');
    return edits;
  }
  const allowedSet = new Set<string>(allowed);
  for (const key of Object.keys(raw)) {
    if (!isSurfaceKey(key)) {
      dropped.push(key + ': unknown harness surface');
      continue;
    }
    if (!allowedSet.has(key)) {
      dropped.push(key + ': surface is not enabled for this run');
      continue;
    }
    const payload = raw[key];
    if (!isRecord(payload)) {
      dropped.push(key + ': payload is not a JSON object');
      continue;
    }
    const result = validateSurfacePayload(key, payload);
    if (!result.ok) {
      dropped.push(key + ': ' + result.reason);
      continue;
    }
    edits[key] = result.value;
  }
  return edits;
}

/** Remove external-memory channels from edits destined for an invariant branch. */
function stripExternalMemoryChannels(
  edits: Partial<Record<HarnessComponentKey, SupportedSurfacePayload>>,
  dropped: string[]
): void {
  const memoryEdit = edits.memory;
  if (memoryEdit === undefined || memoryEdit.kind !== 'memory') {
    return;
  }
  const hasRecallTags = memoryEdit.recallTags !== undefined && memoryEdit.recallTags.length > 0;
  if (hasRecallTags) {
    dropped.push('memory.recallTags stripped: guidance-free branches must not recall external memory');
  }
  const keepsOtherFields =
    memoryEdit.scopedViewId !== undefined ||
    (memoryEdit.workingNotes !== undefined && memoryEdit.workingNotes.length > 0);
  if (!keepsOtherFields) {
    delete edits.memory;
    if (hasRecallTags) {
      dropped.push('memory: edit dropped because only recallTags remained on a guidance-free branch');
    }
    return;
  }
  edits.memory = { ...memoryEdit, recallTags: undefined };
}

function allowedSurfacesFor(request: ProposeRequest): readonly HarnessComponentKey[] {
  const requested = request.enabledSurfaces;
  if (requested === undefined || requested.length === 0) {
    return HARNESS_COMPONENT_KEYS;
  }
  return surfaceKeysInOrder(requested);
}

function resolveFocusSurfaces(raw: unknown, edited: readonly HarnessComponentKey[]): HarnessComponentKey[] {
  const modelPicks = surfaceKeysInOrder(readStringList(raw, 8) ?? []);
  const intersect = modelPicks.filter((key) => edited.includes(key));
  if (intersect.length > 0) {
    return intersect;
  }
  return [...edited];
}

function lessonIds(recall: MemoryRecallResult | undefined): string[] {
  if (recall === undefined) {
    return [];
  }
  const ids: string[] = [];
  for (const lesson of [...recall.positiveLessons, ...recall.negativeLessons]) {
    if (!ids.includes(lesson.id)) {
      ids.push(lesson.id);
    }
  }
  return ids;
}

/**
 * Build the dual-track Harness² proposer. The returned object implements the
 * frozen IHarnessProposer contract; all I/O is the injected model adapter.
 */
export function createDualTrackProposer(options: HarnessProposerOptions): IHarnessProposer {
  const now = options.now ?? systemClock;
  const newId = options.newId ?? createDeterministicIdFactory('propose');
  const maxLessons = options.maxLessonsPerSection ?? 8;
  const model = createMeteredModelAdapter(options.model, 'propose', options.metering);

  const proposer: IHarnessProposer = {
    async propose(request: ProposeRequest): Promise<ProposedPatch> {
      const decision = decideProposalGuidance(request);
      const diagnostics: string[] = [];
      if (decision.sanitized) {
        diagnostics.push(decision.reason);
      }
      const recall: MemoryRecallResult | undefined =
        decision.memoryAllowed && request.guidance.mode === 'domain' ? request.guidance.memory : undefined;

      const modelRequest: ModelRequest = {
        purpose: 'propose',
        messages: renderProposalPrompts(request, { maxLessonsPerSection: maxLessons }),
        temperature: options.temperature ?? 0.2,
        maxTokens: options.maxTokens ?? 2048,
        responseFormat: 'json',
        metadata: {
          sessionId: request.sessionId,
          slot: request.slot.slot,
          guidance: decision.memoryAllowed ? 'memory' : 'guidance_free',
          attemptIndex: request.attemptIndex
        }
      };
      const response = await model.call(modelRequest);
      const parsed = extractJsonValue(response.text);
      const record = isRecord(parsed) ? parsed : undefined;
      if (record === undefined) {
        throw new Harness2ProposalError(
          'proposal_unparseable',
          'Harness² proposer received a model response that is not a JSON object.',
          truncate(oneLine(response.text), 400)
        );
      }

      const allowed = allowedSurfacesFor(request);
      const dropped: string[] = [];
      const edits = parseEdits(record.edits, allowed, dropped);
      if (!decision.memoryAllowed) {
        stripExternalMemoryChannels(edits, dropped);
      }
      const editedSurfaces = surfaceKeysInOrder(Object.keys(edits));
      if (editedSurfaces.length === 0) {
        throw new Harness2ProposalError(
          'proposal_no_valid_edits',
          'Harness² proposer produced no valid surface edit for this slot.',
          dropped.length > 0 ? dropped.join(' | ') : 'model returned an empty edits object'
        );
      }

      const focusSurfaces = resolveFocusSurfaces(record.focusSurfaces, editedSurfaces);
      const rationale =
        nonEmptyString(record.rationale) ??
        'Model proposal for slot ' + request.slot.slot + ' touching ' + editedSurfaces.join(', ') + '.';
      const confidence = clamp01(finiteNumber(record.confidence) ?? 0.5);
      const expectedStepsDelta = finiteNumber(record.expectedStepsDelta);
      const sourceLessonIds = decision.memoryAllowed ? lessonIds(recall) : [];

      const parentPatchIds: string[] = [];
      if (request.parentPatch !== undefined) {
        parentPatchIds.push(request.parentPatch.id);
      }
      for (const seedId of request.slot.seedPatchIds ?? []) {
        if (!parentPatchIds.includes(seedId)) {
          parentPatchIds.push(seedId);
        }
      }

      const metadata: ContractMetadata = {
        slot: request.slot.slot,
        slotIndex: request.slot.slotIndex,
        origin: request.slot.origin,
        attemptIndex: request.attemptIndex,
        requestedGuidanceMode: request.guidance.mode,
        effectiveGuidanceMode: decision.memoryAllowed ? 'memory' : 'guidance_free',
        guidanceSanitized: decision.sanitized,
        droppedEdits: dropped,
        memoryConfidence: recall?.confidence,
        memoryRecallIds: sourceLessonIds,
        diagnostics,
        model: response.model
      };

      const patch: EightSurfacePatch = {
        id: newId('patch'),
        sessionId: request.sessionId,
        branchId: request.slot.branchId,
        origin: request.slot.origin,
        purpose: purposeForSlot(request.slot.slot),
        guidance: decision.memoryAllowed ? 'memory' : 'guidance_free',
        label: request.slot.slot + ':' + editedSurfaces.join('+'),
        rationale,
        edits: edits as EightSurfaceEdits,
        parentPatchIds: parentPatchIds.length > 0 ? parentPatchIds : undefined,
        sourceLessonIds,
        createdAt: now(),
        metadata
      };

      return { patch, rationale, focusSurfaces, confidence, expectedStepsDelta };
    }
  };

  // P3-B (plan section 8): optional multi-candidate path. K>1 asks the model
  // ONCE for a JSON array of candidate objects, validates every element with
  // the same EightSurfacePatch checks as the single path, drops invalid
  // entries (never failing the whole call) and falls back to the proven
  // single-candidate path when nothing usable remains. K<=1 defers to
  // propose() byte-for-byte.
  proposer.proposeCandidates = async (request: ProposeRequest): Promise<ProposedPatchSet> => {
    const requested = request.candidateCount;
    if (!Number.isInteger(requested) || (requested ?? 1) <= 1) {
      const single = await proposer.propose(request);
      return { candidates: [single] };
    }
    const k = requested as number;
    const decision = decideProposalGuidance(request);
    const diagnostics: string[] = [];
    if (decision.sanitized) {
      diagnostics.push(decision.reason);
    }
    const recall: MemoryRecallResult | undefined =
      decision.memoryAllowed && request.guidance.mode === 'domain' ? request.guidance.memory : undefined;
    const modelRequest: ModelRequest = {
      purpose: 'propose',
      messages: renderProposalPrompts(request, { maxLessonsPerSection: maxLessons, candidateCount: k }),
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens ?? 2048,
      responseFormat: 'json',
      metadata: {
        sessionId: request.sessionId,
        slot: request.slot.slot,
        guidance: decision.memoryAllowed ? 'memory' : 'guidance_free',
        attemptIndex: request.attemptIndex,
        candidateCount: k
      }
    };
    const response = await model.call(modelRequest);
    const parsed = extractJsonValue(response.text);
    const rawCandidates: unknown[] = Array.isArray(parsed)
      ? parsed.slice(0, k)
      : isRecord(parsed)
        ? [parsed]
        : [];
    const allowed = allowedSurfacesFor(request);
    const candidates: ProposedPatch[] = [];
    for (let index = 0; index < rawCandidates.length; index += 1) {
      const entry: unknown = rawCandidates[index];
      const label = 'candidate ' + String(index + 1);
      if (!isRecord(entry)) {
        diagnostics.push(label + ': dropped, not a JSON object');
        continue;
      }
      const dropped: string[] = [];
      const edits = parseEdits(entry.edits, allowed, dropped);
      if (!decision.memoryAllowed) {
        stripExternalMemoryChannels(edits, dropped);
      }
      const editedSurfaces = surfaceKeysInOrder(Object.keys(edits));
      if (editedSurfaces.length === 0) {
        diagnostics.push(
          label + ': dropped, no valid surface edit' + (dropped.length > 0 ? ' (' + dropped.join(' | ') + ')' : '')
        );
        continue;
      }
      const rationale =
        nonEmptyString(entry.rationale) ??
        'Model proposal for slot ' + request.slot.slot + ' touching ' + editedSurfaces.join(', ') + '.';
      const focusSurfaces = resolveFocusSurfaces(entry.focusSurfaces, editedSurfaces);
      const confidence = clamp01(finiteNumber(entry.confidence) ?? 0.5);
      const expectedStepsDelta = finiteNumber(entry.expectedStepsDelta);
      const sourceLessonIds = decision.memoryAllowed ? lessonIds(recall) : [];
      const parentPatchIds: string[] = [];
      if (request.parentPatch !== undefined) {
        parentPatchIds.push(request.parentPatch.id);
      }
      for (const seedId of request.slot.seedPatchIds ?? []) {
        if (!parentPatchIds.includes(seedId)) {
          parentPatchIds.push(seedId);
        }
      }
      const metadata: ContractMetadata = {
        slot: request.slot.slot,
        slotIndex: request.slot.slotIndex,
        origin: request.slot.origin,
        attemptIndex: request.attemptIndex,
        requestedGuidanceMode: request.guidance.mode,
        effectiveGuidanceMode: decision.memoryAllowed ? 'memory' : 'guidance_free',
        guidanceSanitized: decision.sanitized,
        candidateIndex: index + 1,
        candidateCountRequested: k,
        droppedEdits: dropped,
        memoryConfidence: recall?.confidence,
        memoryRecallIds: sourceLessonIds,
        diagnostics,
        model: response.model
      };
      candidates.push({
        patch: {
          id: newId('patch'),
          sessionId: request.sessionId,
          branchId: request.slot.branchId,
          origin: request.slot.origin,
          purpose: purposeForSlot(request.slot.slot),
          guidance: decision.memoryAllowed ? 'memory' : 'guidance_free',
          label: request.slot.slot + ':' + editedSurfaces.join('+'),
          rationale,
          edits: edits as EightSurfaceEdits,
          parentPatchIds: parentPatchIds.length > 0 ? parentPatchIds : undefined,
          sourceLessonIds,
          createdAt: now(),
          metadata
        },
        rationale,
        focusSurfaces,
        confidence,
        expectedStepsDelta
      });
    }
    if (candidates.length === 0) {
      const fallback = await proposer.propose(request);
      const fallbackMeta: ContractMetadata = {
        ...(fallback.patch.metadata ?? {}),
        diagnostics: [
          ...((fallback.patch.metadata?.diagnostics as readonly string[]) ?? []),
          'multi-candidate response unusable (' + String(k) + ' requested, 0 valid); fell back to the single-candidate path'
        ]
      };
      return {
        candidates: [{ ...fallback, patch: { ...fallback.patch, metadata: fallbackMeta } }]
      };
    }
    diagnostics.unshift(
      'multi-candidate proposal: requested ' + String(k) + ', accepted ' + String(candidates.length)
    );
    return {
      candidates: candidates.map((candidate) => ({
        ...candidate,
        patch: {
          ...candidate.patch,
          metadata: { ...(candidate.patch.metadata ?? {}), diagnostics: [...diagnostics] }
        }
      }))
    };
  };

  return proposer;
}
