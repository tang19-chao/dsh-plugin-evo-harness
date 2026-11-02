/**
 * Driver 5 — Native Whitebox (灵枢 dsh-memory md_cg 原生直通驱动).
 * Fingerprints: cg, stg, mdcg_remember, mdcg_recall.
 * Recalls through zero-LLM white-box routing (cg op='route') plus the semantic
 * timeline (stg op='timeline'), and writes the CCG six-element text straight into
 * cg(op='write') so 灵枢's own gates adjudicate the write
 * (ARCHITECTURE.md 4.2 row 5).
 *
 * MEM-4: the write text carries the machine-readable frontmatter envelope in
 * front of the rendered six-element body (the envelope path is verified
 * lossless, the rendered-only roundtrip is not), so recall recovers fractional
 * metricsDelta values, multi-line evidence and multi-line cues instead of
 * trusting the lossy rendered parse alone.
 */

import type { CanonicalLesson, MemoryBackendCapabilities } from '../../types/contracts';
import { serializeLesson } from '../lesson-codec';
import { scopeInlineTag } from '../namespace';
import {
  dedupeRecordsById,
  detectBackendRejection,
  recallNamespaceScoped,
  recordsFromPayload,
  resolveFields
} from './shared';
import type {
  IMemoryDriver,
  JsonObject,
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
  // MEM-4: frontmatter envelope first (lossless on recall), rendered CCG body
  // after it so the white-box gate still adjudicates the six elements.
  return scopeInlineTag(namespace) + '\n' + serializeLesson(lesson, { namespace });
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
      // MEM-3: one scalar-namespace call per visible namespace unless the tool
      // declares the filter field as an array.
      const primaryArgs: JsonObject[] = [];
      const results = await recallNamespaceScoped(context, binding.recall, fields.namespace, input.namespaces, (
        namespaceFilterValue
      ) => {
        const args: JsonObject = {};
        if (binding.recall === 'cg') {
          args.op = 'route';
          args.query = input.fingerprint;
          args[fields.limit] = input.limit;
          args[fields.namespace] = namespaceFilterValue;
        } else if (binding.recall === 'stg') {
          args.op = 'timeline';
          args[fields.limit] = input.limit;
          args[fields.namespace] = namespaceFilterValue;
        } else {
          args[fields.query] = input.fingerprint;
          args[fields.limit] = input.limit;
          args[fields.namespace] = namespaceFilterValue;
        }
        primaryArgs.push(args);
        return args;
      });
      const records: ReturnType<typeof recordsFromPayload> = [];
      diagnostics.push(
        'lingshu recall via ' + binding.recall + ' op=' + describeOp(binding.recall, primaryArgs[0] ?? {})
      );
      for (const result of results) {
        records.push(
          ...recordsFromPayload(parseToolPayload(result), {
            namespace: input.namespace,
            limit: input.limit
          })
        );
      }
      if (context.hasTool('stg') && binding.recall !== 'stg') {
        try {
          // MEM-2: the supplemental timeline is scoped exactly like the primary
          // recall — an unscoped stg query pulls cross-namespace records into
          // the set, where hint attribution alone would file them here.
          const timelineFields = resolveFields(context, 'stg');
          const timelineResults = await recallNamespaceScoped(context, 'stg', timelineFields.namespace, input.namespaces, (
            namespaceFilterValue
          ) => {
            const args: JsonObject = { op: 'timeline' };
            args[timelineFields.limit] = input.limit;
            args[timelineFields.namespace] = namespaceFilterValue;
            return args;
          });
          const visible = new Set(input.namespaces);
          const extra: ReturnType<typeof recordsFromPayload> = [];
          for (const timeline of timelineResults) {
            for (const record of recordsFromPayload(parseToolPayload(timeline), {
              namespace: input.namespace,
              limit: input.limit
            })) {
              // Records the payload tags with a namespace outside this scope
              // never belong to the recall set, regardless of backend leniency.
              if (!visible.has(record.namespace)) {
                continue;
              }
              extra.push(record);
            }
          }
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
      return { records: dedupeRecordsById(records).slice(0, input.limit), diagnostics };
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
