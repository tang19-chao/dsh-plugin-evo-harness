/**
 * Driver 5 — Native Whitebox (灵枢 dsh-memory md_cg 原生直通驱动).
 * Fingerprints: cg, stg, mdcg_remember, mdcg_recall.
 * Recalls through zero-LLM white-box routing (cg op='route') plus the semantic
 * timeline (stg op='timeline'), and writes the CCG six-element text straight into
 * cg(op='write') so 灵枢's own gates adjudicate the write
 * (ARCHITECTURE.md 4.2 row 5).
 */

import type { CanonicalLesson, MemoryBackendCapabilities } from '../../types/contracts';
import { renderLessonMarkdown } from '../lesson-codec';
import { scopeInlineTag } from '../namespace';
import { detectBackendRejection, recordsFromPayload, resolveFields } from './shared';
import type {
  IMemoryDriver,
  JsonObject,
  JsonValue,
  MemoryDriverContext,
  MemoryDriverPruneInput,
  MemoryDriverPruneOutput,
  MemoryDriverRecallInput,
  MemoryDriverRecallOutput,
  MemoryDriverToolBinding,
  MemoryDriverWriteInput,
  MemoryDriverWriteOutput
} from '../spi';
import { errorMessage, parseToolPayload } from '../spi';

export const LINGSHU_MDCG_TOOLS = {
  recall: ['mdcg_recall', 'cg', 'stg'],
  commit: ['cg', 'mdcg_remember'],
  prune: ['cg']
} as const;

/** The exact六要素 text handed to cg(op='write'), scope-tagged for isolation. */
export function renderLingshuWriteText(lesson: CanonicalLesson, namespace: string): string {
  return scopeInlineTag(namespace) + '\n' + renderLessonMarkdown(lesson);
}

export function createLingshuMdcgDriver(binding: MemoryDriverToolBinding): IMemoryDriver {
  const capabilities: MemoryBackendCapabilities = {
    metadataFiltering: true,
    namespaces: true,
    negativePolarity: true,
    temporal: true,
    supportsPrune: binding.prune !== undefined
  };
  const pruneTool = binding.prune;
  const driver: IMemoryDriver = {
    kind: 'lingshu_mdcg',
    label: '灵枢 dsh-memory white-box native driver (cg/stg)',
    capabilities,
    binding,
    async recall(
      context: MemoryDriverContext,
      input: MemoryDriverRecallInput
    ): Promise<MemoryDriverRecallOutput> {
      const fields = resolveFields(context, binding.recall);
      const diagnostics: string[] = [];
      const scopeArg: JsonValue = input.namespaces.length > 1 ? [...input.namespaces] : input.namespace;
      const args: JsonObject = {};
      if (binding.recall === 'cg') {
        args.op = 'route';
        args.query = input.fingerprint;
        args[fields.limit] = input.limit;
        args[fields.namespace] = scopeArg;
      } else if (binding.recall === 'stg') {
        args.op = 'timeline';
        args[fields.limit] = input.limit;
        args[fields.namespace] = scopeArg;
      } else {
        args[fields.query] = input.fingerprint;
        args[fields.limit] = input.limit;
        args[fields.namespace] = scopeArg;
      }
      const result = await context.call(binding.recall, args);
      diagnostics.push('lingshu recall via ' + binding.recall + " op=" + describeOp(binding.recall, args));
      const records = recordsFromPayload(parseToolPayload(result), {
        namespace: input.namespace,
        limit: input.limit
      });
      if (context.hasTool('stg') && binding.recall !== 'stg') {
        try {
          const timeline = await context.call('stg', { op: 'timeline', limit: input.limit });
          const extra = recordsFromPayload(parseToolPayload(timeline), {
            namespace: input.namespace,
            limit: input.limit
          });
          diagnostics.push('lingshu stg timeline added ' + extra.length + ' record(s)');
          for (const record of extra) {
            if (!records.some((existing) => existing.lesson.id === record.lesson.id)) {
              records.push(record);
            }
          }
        } catch (error) {
          diagnostics.push('lingshu timeline lookup degraded: ' + errorMessage(error));
        }
      }
      return { records: records.slice(0, input.limit), diagnostics };
    },
    async commit(
      context: MemoryDriverContext,
      input: MemoryDriverWriteInput
    ): Promise<MemoryDriverWriteOutput> {
      const fields = resolveFields(context, binding.commit);
      const text = renderLingshuWriteText(input.lesson, input.namespace);
      const args: JsonObject = {};
      if (binding.commit === 'cg') {
        args.op = 'write';
        args.content = text;
      } else {
        args[fields.text] = text;
      }
      args[fields.namespace] = input.namespace;
      args[fields.metadata] = {
        namespace: input.namespace,
        harness_lesson: 1,
        polarity: input.lesson.polarity,
        visibility: input.lesson.visibility,
        whenNotToApply: [...input.lesson.whenNotToApply]
      };
      const result = await context.call(binding.commit, args);
      const payload = parseToolPayload(result);
      const rejection = detectBackendRejection(payload, result);
      if (rejection !== undefined) {
        return {
          persisted: false,
          violations: [
            {
              code: 'invalid_lesson',
              message: '灵枢 white-box gate rejected the lesson: ' + rejection,
              severity: 'block'
            }
          ]
        };
      }
      return {
        persisted: true,
        backendRef: 'mdcg:' + input.lesson.id,
        diagnostics: ['lingshu accepted lesson ' + input.lesson.id + ' in namespace ' + input.namespace]
      };
    },
    async prune(
      context: MemoryDriverContext,
      input: MemoryDriverPruneInput
    ): Promise<MemoryDriverPruneOutput> {
      if (pruneTool === undefined) {
        return { removedIds: [], diagnostics: ['lingshu backend exposes no forget tool'] };
      }
      try {
        await context.call(pruneTool, { op: 'forget', ids: [...input.ids], namespace: input.namespace });
        return { removedIds: [...input.ids], diagnostics: ['lingshu forgot ' + input.ids.length + ' lesson(s)'] };
      } catch (error) {
        return { removedIds: [], diagnostics: ['lingshu forget failed: ' + errorMessage(error)] };
      }
    }
  };
  return driver;
}

function describeOp(tool: string, args: JsonObject): string {
  const op = args.op;
  return typeof op === 'string' ? op : tool;
}
