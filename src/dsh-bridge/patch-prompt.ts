/**
 * Render a branch patch's EDITS into the probe prompt (rev6 audit A1/B1).
 *
 * WHY THIS MODULE EXISTS
 * The default probe headers below (`branch.ts` and `agent-loop-executor.ts`)
 * carried only the surface NAMES, the patch id and the rationale. A candidate
 * probe and the reference probe therefore differed by one rationale line while
 * the patch body - the thing the probe is supposed to evaluate - never reached
 * the model. The Harness² contrast, the JitRL experience and every downstream
 * Dream replay were all built on probes that had not been given the scaffold.
 *
 * RENDERING RULES (rev6 A1 table)
 *   - system_prompt (append)   -> `## system_prompt (append)` section
 *   - system_prompt (replace)  -> `## system_prompt (replace)` section, FIRST
 *     in the patch tail. The default header is NEVER overwritten: keeping it
 *     byte-identical for a given context is what lets an empty patch return
 *     `defaultBranchMessages` unchanged. The header itself embeds the branch,
 *     namespace, patch id and rationale, so it is NOT stable ACROSS requests
 *     (every candidate and the reference have a different header). No
 *     cross-request prefix-cache benefit is claimed here.
 *   - guardrails               -> output contract + append rules + forbidden
 *     actions + tool preconditions
 *   - memory                   -> branch-scoped working notes + recall tags.
 *     `scopedViewId` is deliberately not rendered and NO real recall runs: a
 *     text probe cannot exercise the memory backend.
 *   - tool_guidance            -> descriptions + priority + examples
 *   - skills                   -> one `## skill: <name>` section per skill
 *   - scripts / subagents / plugins -> a single `not evaluable` LINE naming the
 *     surfaces that are present. Their payload bodies are NEVER rendered: a
 *     text probe cannot execute generated code, register a subagent or mount
 *     middleware, so putting the code in the prompt would only invite the model
 *     to pretend it ran.
 *
 * MESSAGE ORDER
 *   `[default header (system), patch block (system), ...rest (the task user)]`
 * i.e. the patch block is inserted AFTER the first message, never appended at
 * the end (a trailing system message after the user task is not a valid
 * instruction position and breaks the "header first within each request"
 * message-order contract).
 *
 * EMPTY PATCH
 *   `appendPatchSections` returns the SAME `base` array reference when nothing
 *   renders (no edits, or only edits whose payload produces an empty body). That
 *   is the byte-for-byte compatibility contract with the default builders.
 *
 * This module imports from the frozen contracts module only (types plus the
 * canonical surface-key tuple). Keeping it free of `branch.ts` is deliberate:
 * `branch.ts` imports `appendPatchSections` from here, so a reverse import would
 * be an ESM cycle.
 */
import {
  HARNESS_COMPONENT_KEYS,
  type HarnessComponentKey,
  type IsolatedBranchContext,
  type ModelMessage
} from '../types/contracts';

/**
 * Surfaces a text-only probe can actually evaluate. ONE source of truth: the
 * S2 surface-evaluability matrix must re-use this constant (or this module must
 * re-export the matrix's copy) rather than declare a second array.
 */
export const TEXT_PROBE_EVALUABLE = [
  'system_prompt',
  'guardrails',
  'memory',
  'tool_guidance',
  'skills'
] as const;

/** A surface whose payload cannot be exercised by a text probe. */
const EVALUABLE_KEYS = new Set<string>(TEXT_PROBE_EVALUABLE);

/**
 * The complement of TEXT_PROBE_EVALUABLE, derived from the canonical eight
 * surface keys so a newly added surface is automatically reported as
 * not-evaluable instead of silently disappearing from the prompt.
 */
export const TEXT_PROBE_NOT_EVALUABLE: readonly HarnessComponentKey[] = HARNESS_COMPONENT_KEYS.filter(
  (key) => !EVALUABLE_KEYS.has(key)
);

/** First line of the injected patch block; also the surprise-free test marker. */
export const PATCH_PROMPT_PREFIX = '# Active harness patch for this branch';

/** What `renderPatchSections` found in one patch. */
export interface RenderedPatchSections {
  /** system_prompt.replace body; undefined when the edit is append/absent. */
  readonly replaceSystem?: string;
  /** Rendered append sections, in the fixed order documented above. */
  readonly sections: readonly string[];
  /**
   * Edited surfaces whose payload actually produced rendered content. A key
   * can be present while this list omits it (`guardrails: { appendRules: [] }`,
   * `memory: { scopedViewId: 'x' }`): such a patch has nothing a text probe can
   * evaluate and must not be admitted on key presence alone (rev6 A1/A3).
   */
  readonly renderedSurfaces: readonly HarnessComponentKey[];
  /** Present surfaces whose payload a text probe cannot evaluate. */
  readonly notEvaluable: readonly HarnessComponentKey[];
}

/** Plain-object guard that never throws on a proxy or host-built value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Non-empty trimmed string, or undefined. */
function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Non-empty trimmed strings from an array, preserving order. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      out.push(entry.trim());
    }
  }
  return out;
}

/** Bulleted lines for a string list. */
function bulletLines(items: readonly string[], prefix = '- '): string[] {
  return items.map((item) => prefix + item);
}

/** Render one guardrails payload body; empty array when it says nothing. */
function renderGuardrailsBody(edit: Record<string, unknown>): string[] {
  const body: string[] = [];
  const formatContract = nonEmptyText(edit.formatContract);
  if (formatContract !== undefined) {
    body.push('Output contract: ' + formatContract);
  }
  body.push(...bulletLines(stringList(edit.appendRules)));
  for (const forbidden of stringList(edit.forbiddenActions)) {
    body.push('- forbidden: ' + forbidden);
  }
  if (Array.isArray(edit.toolPreconditions)) {
    for (const precondition of edit.toolPreconditions) {
      if (!isRecord(precondition)) {
        continue;
      }
      const toolName = nonEmptyText(precondition.toolName);
      const rule = nonEmptyText(precondition.rule);
      if (toolName !== undefined && rule !== undefined) {
        body.push('- precondition ' + toolName + ': ' + rule);
      }
    }
  }
  return body;
}

/** Render one memory payload body; empty array when it says nothing. */
function renderMemoryBody(edit: Record<string, unknown>): string[] {
  const body = bulletLines(stringList(edit.workingNotes));
  for (const tag of stringList(edit.recallTags)) {
    body.push('- recall tag: ' + tag);
  }
  return body;
}

/** Render one tool_guidance payload body; empty array when it says nothing. */
function renderToolGuidanceBody(edit: Record<string, unknown>): string[] {
  const body: string[] = [];
  if (isRecord(edit.descriptions)) {
    for (const [toolName, description] of Object.entries(edit.descriptions)) {
      const text = nonEmptyText(description);
      if (text !== undefined) {
        body.push('- ' + toolName + ': ' + text);
      }
    }
  }
  const priorityOrder = stringList(edit.priorityOrder);
  if (priorityOrder.length > 0) {
    body.push('- priority: ' + priorityOrder.join(' > '));
  }
  if (Array.isArray(edit.examples)) {
    for (const example of edit.examples) {
      if (!isRecord(example)) {
        continue;
      }
      const toolName = nonEmptyText(example.toolName);
      const text = nonEmptyText(example.example);
      if (toolName !== undefined && text !== undefined) {
        body.push('- example ' + toolName + ': ' + text);
      }
    }
  }
  return body;
}

/** Render one skills payload into one section per usable skill. */
function renderSkillSections(edit: Record<string, unknown>): string[] {
  const sections: string[] = [];
  if (!Array.isArray(edit.skills)) {
    return sections;
  }
  for (const skill of edit.skills) {
    if (!isRecord(skill)) {
      continue;
    }
    const name = nonEmptyText(skill.name);
    if (name === undefined) {
      continue;
    }
    const markdown = typeof skill.markdown === 'string' ? skill.markdown : '';
    sections.push('## skill: ' + name + '\n' + markdown);
  }
  return sections;
}

/**
 * Render one edits bag into the fixed-order section list.
 *
 * Total and non-throwing: a malformed patch (a null edits bag, a null payload,
 * a non-array list) renders nothing instead of rejecting the branch. The branch
 * executor calls its builder BEFORE its own try/catch, so an exception here
 * would surface as a zero-step failed trajectory from the seam manager; a
 * prompt renderer must never be able to do that.
 *
 * `renderedSurfaces` is the CONTENT-level truth A3 needs: it is derived from the
 * same lines that are actually pushed into `sections`, so a renderer change
 * cannot leave the evaluability matrix behind.
 */
export function renderPatchEdits(editsValue: unknown): RenderedPatchSections {
  const edits = isRecord(editsValue) ? editsValue : {};

  const sections: string[] = [];
  const renderedSurfaces: HarnessComponentKey[] = [];
  let replaceSystem: string | undefined;

  const systemPrompt = edits.system_prompt;
  if (isRecord(systemPrompt)) {
    const content = nonEmptyText(systemPrompt.content);
    if (content !== undefined) {
      if (systemPrompt.mode === 'replace') {
        replaceSystem = content;
      } else {
        sections.push('## system_prompt (append)\n' + content);
      }
      renderedSurfaces.push('system_prompt');
    }
  }

  const guardrails = edits.guardrails;
  if (isRecord(guardrails)) {
    const body = renderGuardrailsBody(guardrails);
    if (body.length > 0) {
      sections.push('## guardrails\n' + body.join('\n'));
      renderedSurfaces.push('guardrails');
    }
  }

  const memory = edits.memory;
  if (isRecord(memory)) {
    const body = renderMemoryBody(memory);
    if (body.length > 0) {
      sections.push('## memory (branch-scoped working notes)\n' + body.join('\n'));
      renderedSurfaces.push('memory');
    }
  }

  const toolGuidance = edits.tool_guidance;
  if (isRecord(toolGuidance)) {
    const body = renderToolGuidanceBody(toolGuidance);
    if (body.length > 0) {
      sections.push('## tool_guidance\n' + body.join('\n'));
      renderedSurfaces.push('tool_guidance');
    }
  }

  const skills = edits.skills;
  if (isRecord(skills)) {
    const skillSections = renderSkillSections(skills);
    sections.push(...skillSections);
    if (skillSections.length > 0) {
      renderedSurfaces.push('skills');
    }
  }

  const notEvaluable = TEXT_PROBE_NOT_EVALUABLE.filter((key) => edits[key] !== undefined);

  return {
    ...(replaceSystem === undefined ? {} : { replaceSystem }),
    sections,
    renderedSurfaces,
    notEvaluable
  };
}

/** Render the patch edits of one branch context (see {@link renderPatchEdits}). */
export function renderPatchSections(context: IsolatedBranchContext): RenderedPatchSections {
  const patch: unknown = context.patch;
  const editsValue: unknown = isRecord(patch) ? patch.edits : undefined;
  return renderPatchEdits(editsValue);
}

/**
 * Insert the rendered patch block after the first (header) message.
 *
 * `base` is returned BY REFERENCE when there is nothing to render. A host that
 * supplies its own `buildMessages` never reaches this function: explicit host
 * prompts remain authoritative and are not silently augmented with a patch.
 */
export function appendPatchSections(
  base: readonly ModelMessage[],
  context: IsolatedBranchContext
): readonly ModelMessage[] {
  const rendered = renderPatchSections(context);
  if (
    rendered.replaceSystem === undefined &&
    rendered.sections.length === 0 &&
    rendered.notEvaluable.length === 0
  ) {
    return base;
  }

  const blocks = [
    ...(rendered.replaceSystem === undefined
      ? []
      : ['## system_prompt (replace)\n' + rendered.replaceSystem]),
    ...rendered.sections,
    ...(rendered.notEvaluable.length === 0
      ? []
      : ['## not evaluable in a text probe: ' + rendered.notEvaluable.join(', ')])
  ];
  const patchMessage: ModelMessage = {
    role: 'system',
    content: PATCH_PROMPT_PREFIX + '\n' + blocks.join('\n\n')
  };

  const header = base[0];
  if (header === undefined) {
    return [patchMessage];
  }
  return [header, patchMessage, ...base.slice(1)];
}
