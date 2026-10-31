/**
 * Eight-surface classification contract (rev5 P1-1 / A-t10-3).
 *
 * The point of these tests is the HONESTY rule, not table plumbing:
 *   - config presence never upgrades a face to `native`;
 *   - the plugin's in-memory reference adapter is `fallback`, never `native`;
 *   - a face the hook adapter cannot forward (bare Cordis Context) is `not-run`
 *     with a stated limitation, never `unavailable` and never `native`;
 *   - a missing seam on a non-hook adapter IS `unavailable`.
 *
 * They also pin the two ways the rendered evidence can lie: a `native` row whose
 * seam is absent, and a non-native row with no limitation text.
 */
import { describe, expect, it } from 'vitest';
import type { CordisHostAdapter } from '../../../src/cordis-seams/host-adapter';
import { HARNESS_COMPONENT_KEYS } from '../../../src/types/contracts';
import {
  HOOK_NATIVE_METHODS,
  classifySurfaceMatrix,
  countSurfaceAvailability,
  renderSurfaceMatrix,
  validateSurfaceMatrix
} from './surface-matrix';

const ALL_METHODS = [
  'registerPromptSegment',
  'registerGuardrails',
  'registerMemoryScope',
  'patchToolGuidance',
  'mountSkills',
  'mountScripts',
  'registerSubagents',
  'mountMiddleware'
] as const;

function fakeAdapter(methods: readonly string[]): CordisHostAdapter {
  const adapter: Record<string, unknown> = {};
  for (const method of methods) {
    adapter[method] = async () => ({ dispose() {} });
  }
  return adapter as unknown as CordisHostAdapter;
}

const baseInput = {
  capturedAt: '2026-10-30T00:00:00.000Z',
  hookDetected: true,
  structuralSeams: 0,
  enabledSurfaces: [...HARNESS_COMPONENT_KEYS]
};

describe('classifySurfaceMatrix', () => {
  it('marks every face not-run when no adapter was resolved', () => {
    const matrix = classifySurfaceMatrix({ ...baseInput, adapter: undefined, hostAdapterSource: 'not-run' });
    expect(matrix.faces).toHaveLength(HARNESS_COMPONENT_KEYS.length);
    expect(matrix.faces.every((face) => face.availability === 'not-run')).toBe(true);
    expect(matrix.faces.every((face) => (face.limitation ?? '').length > 0)).toBe(true);
    expect(matrix.problems.length).toBeGreaterThan(0);
  });

  it('classifies a structural context adapter with every seam as native', () => {
    const matrix = classifySurfaceMatrix({
      ...baseInput,
      adapter: fakeAdapter(ALL_METHODS),
      hostAdapterSource: 'context'
    });
    expect(matrix.faces.every((face) => face.availability === 'native')).toBe(true);
    expect(matrix.faces.every((face) => face.mechanism === 'cordis-ctx-seam')).toBe(true);
    expect(validateSurfaceMatrix(matrix)).toEqual([]);
  });

  it('classifies the plugin in-memory reference adapter as fallback, never native', () => {
    const matrix = classifySurfaceMatrix({
      ...baseInput,
      adapter: fakeAdapter(ALL_METHODS),
      hostAdapterSource: 'in-memory'
    });
    expect(matrix.faces.every((face) => face.availability === 'fallback')).toBe(true);
    expect(matrix.faces.every((face) => face.mechanism === 'in-memory-reference')).toBe(true);
    expect(matrix.faces.every((face) => (face.limitation ?? '').length > 0)).toBe(true);
    expect(validateSurfaceMatrix(matrix)).toEqual([]);
  });

  it('keeps the dsh-hooks faces honest: hook-shaped native, unforwarded not-run', () => {
    const matrix = classifySurfaceMatrix({
      ...baseInput,
      // The hook adapter always defines the three hook-shaped methods; the other
      // five exist only when it can forward them to a structural fallback.
      adapter: fakeAdapter(HOOK_NATIVE_METHODS),
      hostAdapterSource: 'dsh-hooks'
    });
    const native = matrix.faces.filter((face) => face.availability === 'native');
    const notRun = matrix.faces.filter((face) => face.availability === 'not-run');
    expect(native).toHaveLength(3);
    expect(native.every((face) => face.mechanism === 'dsh-hook')).toBe(true);
    expect(notRun).toHaveLength(5);
    expect(notRun.every((face) => (face.limitation ?? '').length > 0)).toBe(true);
    expect(validateSurfaceMatrix(matrix)).toEqual([]);
  });

  it('attaches the manifest dispatch fact to the hook-native evidence', () => {
    const matrix = classifySurfaceMatrix({
      ...baseInput,
      adapter: fakeAdapter(HOOK_NATIVE_METHODS),
      hostAdapterSource: 'dsh-hooks',
      hookEvidence: [
        { event: 'system-prompt/assemble', dispatched: true, payloadFields: ['sessionId', 'messages'] },
        { event: 'tools/pre-execute', dispatched: true, payloadFields: ['toolName'] },
        { event: 'agent/pre-step', dispatched: false, payloadFields: [] }
      ]
    });
    const prompt = matrix.faces.find((face) => face.surface === 'system_prompt');
    const guardrails = matrix.faces.find((face) => face.surface === 'guardrails');
    expect(prompt?.evidence).toContain('dispatch[system-prompt/assemble]=true');
    expect(guardrails?.evidence).toContain('dispatch[tools/pre-execute]=true');
    // A not-dispatched hook is reported as false, never upgraded.
    const plugins = matrix.faces.find((face) => face.surface === 'plugins');
    expect(plugins?.evidence).toContain('dispatch[agent/pre-step]=false');
  });

  it('classifies forwarded dsh-hooks seams as native Cordis ctx seams', () => {
    const matrix = classifySurfaceMatrix({
      ...baseInput,
      adapter: fakeAdapter(ALL_METHODS),
      hostAdapterSource: 'dsh-hooks',
      structuralSeams: 5
    });
    expect(matrix.faces.every((face) => face.availability === 'native')).toBe(true);
    const forwarded = matrix.faces.filter((face) => face.mechanism === 'cordis-ctx-seam');
    expect(forwarded).toHaveLength(5);
  });

  it('reports a missing seam on a non-hook adapter as unavailable', () => {
    const matrix = classifySurfaceMatrix({
      ...baseInput,
      adapter: fakeAdapter(['mountSkills']),
      hostAdapterSource: 'context'
    });
    const unavailable = matrix.faces.filter((face) => face.availability === 'unavailable');
    expect(unavailable).toHaveLength(7);
    expect(unavailable.every((face) => face.mechanism === 'none')).toBe(true);
    expect(matrix.faces.filter((face) => face.surface === 'skills')[0]?.availability).toBe('native');
    expect(validateSurfaceMatrix(matrix)).toEqual([]);
  });

  it('never upgrades a face to native because config enables it', () => {
    const matrix = classifySurfaceMatrix({ ...baseInput, adapter: undefined, hostAdapterSource: 'not-run' });
    // enabledSurfaces contains every key, and every face is still not-run.
    expect(matrix.faces.every((face) => face.configured)).toBe(true);
    expect(matrix.faces.some((face) => face.availability === 'native')).toBe(false);
  });
});

describe('countSurfaceAvailability', () => {
  it('counts exactly the faces and sums to eight', () => {
    const matrix = classifySurfaceMatrix({
      ...baseInput,
      adapter: fakeAdapter(HOOK_NATIVE_METHODS),
      hostAdapterSource: 'dsh-hooks'
    });
    const counts = countSurfaceAvailability(matrix);
    expect(counts.native + counts.fallback + counts.unavailable + counts['not-run']).toBe(HARNESS_COMPONENT_KEYS.length);
    expect(counts.native).toBe(3);
    expect(counts['not-run']).toBe(5);
  });
});

describe('validateSurfaceMatrix', () => {
  it('rejects a native row whose seam is absent', () => {
    const matrix = classifySurfaceMatrix({ ...baseInput, adapter: fakeAdapter(ALL_METHODS), hostAdapterSource: 'context' });
    const tampered = {
      ...matrix,
      faces: matrix.faces.map((face, index) => (index === 0 ? { ...face, seamPresent: false } : face))
    };
    expect(validateSurfaceMatrix(tampered).join('; ')).toContain('is native but its seam is not present');
  });

  it('rejects a non-native row without a limitation', () => {
    const matrix = classifySurfaceMatrix({ ...baseInput, adapter: fakeAdapter(ALL_METHODS), hostAdapterSource: 'in-memory' });
    const tampered = {
      ...matrix,
      faces: matrix.faces.map((face) => ({ ...face, limitation: '   ' }))
    };
    const problems = validateSurfaceMatrix(tampered).join('; ');
    expect(problems).toContain('without a limitation/reason');
  });

  it('rejects a matrix that drops a face', () => {
    const matrix = classifySurfaceMatrix({ ...baseInput, adapter: fakeAdapter(ALL_METHODS), hostAdapterSource: 'context' });
    const tampered = { ...matrix, faces: matrix.faces.slice(0, 7) };
    expect(validateSurfaceMatrix(tampered).join('; ')).toContain('must classify all 8 surfaces');
  });
});

describe('renderSurfaceMatrix', () => {
  it('renders one row per surface plus the mandatory limitation paragraph', () => {
    const matrix = classifySurfaceMatrix({
      ...baseInput,
      adapter: fakeAdapter(HOOK_NATIVE_METHODS),
      hostAdapterSource: 'dsh-hooks',
      resolveHostAdapterSource: 'in-memory',
      resolveNote: '生产解析在同一裸上下文上得到 in-memory。'
    });
    const rendered = renderSurfaceMatrix(matrix);
    for (const surface of HARNESS_COMPONENT_KEYS) {
      expect(rendered).toContain('`' + surface + '`');
    }
    expect(rendered).toContain('限制条件（必须随本表一起引用）');
    expect(rendered).toContain('not-run');
    expect(rendered).toContain('native=3');
    expect(rendered).toContain('not-run=5');
    expect(rendered).toContain('生产解析 `resolveHostAdapter`');
    expect(rendered).toContain('in-memory');
    // Every pipe-cell must be escaped: a raw '|' would split the markdown row.
    const tableRows = rendered.split('\n').filter((line) => line.startsWith('| `'));
    expect(tableRows).toHaveLength(HARNESS_COMPONENT_KEYS.length);
    for (const row of tableRows) {
      expect(row.split('|').length).toBe(9); // 8 boundaries + leading/trailing empties
    }
  });
});
