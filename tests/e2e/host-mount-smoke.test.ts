/**
 * Mount smoke on the production resolution path (P0-1 permanent gate).
 *
 * The documented DSH mount (cordis.patch.yml) supplies NO options.model and NO
 * options.runBranch: every collaborator is resolved from the host context
 * through src/dsh-bridge at mount time. Every other e2e file injects
 * options.model / options.runBranch directly, which bypasses that path - the
 * exact gap that let a refactor drop the deferred-collaborator forwarding while
 * the whole suite stayed green (each run silently degrading to `no_probe`).
 *
 * This file mounts with a fake ctx.llm ONLY and fails when the run still
 * produces zero probes. The scripted stream answers per prompt family the same
 * way tests/e2e/fixtures.ts createScriptedModel does, but routes on message
 * content because the DSH stream interface carries no purpose field.
 */
import { describe, expect, it } from 'vitest';

import { createEvoHarnessPlugin } from '../../src/index';
import { createFakeContext, e2eConfig, makeClock, proposalPayload } from './fixtures';

/** Minimal DshGenerateOptions view: the routed messages are all we need. */
interface FakeStreamOptions {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
}

/** A ctx.llm.stream stand-in that answers propose/compose/reflect/probe prompts. */
function createHostLlm(): { stream: (options: FakeStreamOptions) => AsyncIterable<unknown> } {
  return {
    stream: async function* (options: FakeStreamOptions): AsyncIterable<unknown> {
      const joined = options.messages.map((message) => message.content).join('\n');
      let reply: string;
      if (joined.includes('You are the Harness² proposer')) {
        reply = JSON.stringify(proposalPayload());
      } else if (/candidate_[A-Z]/.test(joined)) {
        const aliases = [...new Set(joined.match(/candidate_[A-Z]/g) ?? [])];
        reply = JSON.stringify({
          ranking: aliases,
          assessments: aliases.map((alias, index) => ({
            alias,
            rationale: 'ranked ' + String(index + 1) + ' by the host judge'
          }))
        });
      } else if (joined.includes('probe run inside an isolated evolution branch')) {
        reply = 'host probe deliverable: the failing build passes with the mounted guardrails';
      } else {
        reply = JSON.stringify({ lessons: [] });
      }
      yield { type: 'text-delta', index: 0, text: reply };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  };
}

describe('plugin mount on a host-resolved context (no options.model / options.runBranch)', () => {
  it('runs probes through the collaborators resolved from ctx.llm', async () => {
    const { ctx } = createFakeContext();
    const hostCtx = { ...ctx, llm: createHostLlm() };
    const plugin = createEvoHarnessPlugin({
      config: e2eConfig(),
      now: makeClock()
    }, hostCtx);

    // Detection settles before the first run, exactly as on a real host where
    // the run is triggered by an event or a slash command after mount.
    await plugin.collaborators;
    expect(plugin.diagnostics.join(' ')).toContain('model route in effect');

    const result = await plugin.run({
      sessionId: 'sess-host-mount',
      task: plugin.makeTask({ prompt: 'Fix the failing build without breaking the release train.' }),
      trigger: 'always'
    });

    // The permanent gate: before the forwarding was restored, every probe in
    // this configuration failed loudly and the run ended with probesRun === 0.
    expect(result.probesRun).toBeGreaterThan(0);
    expect(result.diagnostics.join(' ')).not.toContain('no model adapter was injected');
  });
});
