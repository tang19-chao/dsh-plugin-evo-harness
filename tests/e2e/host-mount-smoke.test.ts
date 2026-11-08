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
 * REV6 A2 (audit B2): the ORIGINAL fake read `message.content` as a string.
 * The real adapter sends a DSH content BLOCK ARRAY, so every route missed, the
 * proposer answered `{lessons:[]}`, and the run ended at `outcome = no_probe`
 * with `probesRun = 1` (reference only) while this gate still passed. The fake
 * now decodes blocks through `decodeContent`, and the assertions below pin the
 * three facts the old gate could not see: a real outcome, more than one probe,
 * and the patch markers inside candidate prompts (never in the reference).
 */
import { describe, expect, it } from 'vitest';

import { createEvoHarnessPlugin } from '../../src/index';
import { PATCH_PROMPT_PREFIX } from '../../src/dsh-bridge/patch-prompt';
import {
  createFakeContext,
  createPatchAwareHostLlm,
  e2eConfig,
  makeClock
} from './fixtures';

/** Markers only the proposer's edits can put into a probe prompt. */
const MARK_SYS = 'HOST_MARK_SYS_7731';
const MARK_GUARD = 'Return minified JSON only.';

/** A proposal that edits system_prompt + guardrails, so both surfaces render. */
function markedProposal(): Record<string, unknown> {
  return {
    rationale: 'Pin the failing tool in the prompt before the probe retries.',
    focusSurfaces: ['system_prompt', 'guardrails'],
    confidence: 0.72,
    expectedStepsDelta: -1,
    edits: {
      system_prompt: {
        kind: 'system_prompt',
        mode: 'append',
        content: 'declare the failing tool before retrying (' + MARK_SYS + ')'
      },
      guardrails: {
        kind: 'guardrails',
        formatContract: MARK_GUARD,
        appendRules: ['declare the failing tool before retrying']
      }
    }
  };
}

describe('plugin mount on a host-resolved context (no options.model / options.runBranch)', () => {
  it('runs probes through the collaborators resolved from ctx.llm', async () => {
    const { ctx } = createFakeContext();
    const host = createPatchAwareHostLlm({ proposals: [markedProposal()] });
    const hostCtx = { ...ctx, llm: host };
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

    // A2: BEFORE the content-block decode this configuration ended at
    // `outcome = no_probe` with `probesRun = 1` (reference only) and the old
    // assertion `probesRun > 0` still passed. All three assertions below are
    // load-bearing.
    expect(result.outcome).not.toBe('no_probe');
    expect(result.probesRun).toBeGreaterThan(1);
    expect(result.diagnostics.join(' ')).not.toContain('no model adapter was injected');

    // A1/A2: every probe prompt observed through the REAL adapter must be
    // decoded, and candidate probes must carry the patch the proposer emitted.
    expect(host.probePrompts).toHaveLength(result.probesRun);
    expect(host.probeDispatches).toHaveLength(result.probesRun);
    // Identity, not content: prompt text alone cannot tell whether the REFERENCE
    // was patched or only some candidate was. The reference is the unique
    // dispatch whose branch id starts with `reference-`.
    const referenceDispatches = host.probeDispatches.filter(
      (dispatch) => dispatch.branch?.startsWith('reference-') === true
    );
    const candidateDispatches = host.probeDispatches.filter(
      (dispatch) => dispatch.branch?.startsWith('reference-') !== true
    );
    expect(referenceDispatches).toHaveLength(1);
    expect(candidateDispatches).toHaveLength(result.probesRun - 1);
    const patched = candidateDispatches.filter((dispatch) =>
      dispatch.prompt.includes(PATCH_PROMPT_PREFIX)
    );
    const unpatched = candidateDispatches.filter(
      (dispatch) => !dispatch.prompt.includes(PATCH_PROMPT_PREFIX)
    );

    // EVERY candidate carries the patch; NO reference does.
    expect(patched).toHaveLength(candidateDispatches.length);
    expect(patched.every((dispatch) => dispatch.prompt.includes(MARK_SYS))).toBe(true);
    expect(patched.every((dispatch) => dispatch.prompt.includes(MARK_GUARD))).toBe(true);
    expect(unpatched).toEqual([]);

    // The reference patch has no edits, so its prompt must be byte-identical to
    // the default header + task: no patch block and no marker of any kind.
    expect(referenceDispatches.every((dispatch) => !dispatch.prompt.includes(MARK_SYS))).toBe(true);
    expect(referenceDispatches.every((dispatch) => !dispatch.prompt.includes(MARK_GUARD))).toBe(true);
    expect(referenceDispatches.every((dispatch) => !dispatch.prompt.includes(PATCH_PROMPT_PREFIX))).toBe(true);
  });
});
