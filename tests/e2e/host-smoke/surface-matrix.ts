/**
 * Eight-surface classification for the host smoke (rev5 P1-1 / A-t10-3).
 *
 * WHY THIS EXISTS
 * ---------------
 * The P6.1-F manifest records capability facts about the installed host
 * (hooks, permissions, identity carriers). It never answered the rev5 question:
 * for each `HARNESS_COMPONENT_KEYS` surface, is the host's own mechanism
 * available (`native`), is only the plugin's in-process reference emulation
 * available (`fallback`), or did the probe observe nothing (`unavailable` /
 * `not-run`)?
 *
 * The classification is deliberately conservative:
 *   - "configured" is NOT evidence. `config.enabledSurfaces` says the plugin
 *     wants to mount a surface, not that the host can accept it.
 *   - a seam is `native` only when the resolved adapter that the plugin would
 *     actually use exposes the host method (dsh hook listener or Cordis ctx
 *     service); the plugin's own `createInMemoryCordisHost()` is `fallback`.
 *   - an observable absence is `unavailable`; an UNOBSERVABLE face (this runner
 *     constructs a bare Cordis Context, so the host's service seams are not
 *     injected into it) is `not-run` with the limitation spelled out. It is
 *     never upgraded to `native` by config or by assumption.
 *
 * Everything here runs inside the installed DSH runtime; nothing imports the
 * type from src/index.ts, so the probe cannot become a production dependency.
 *
 * Ownership: tests/e2e/host-smoke/**.
 */
import type { CordisHostAdapter } from '../../../src/cordis-seams/host-adapter';
import { HARNESS_COMPONENT_KEYS, type HarnessComponentKey } from '../../../src/types/contracts';
import { SURFACE_HOST_METHOD } from '../../../src/cordis-seams/eight-surfaces';

/** The three-valued rev5 vocabulary, plus the honest "not observed" state. */
export type SurfaceAvailability = 'native' | 'fallback' | 'unavailable' | 'not-run';

/** Which mechanism produced the classification. */
export type SurfaceMechanism =
  | 'dsh-hook'
  | 'cordis-ctx-seam'
  | 'in-memory-reference'
  | 'injected-adapter'
  | 'not-observed'
  | 'none';

/** One surface's classification and the probe evidence behind it. */
export interface SurfaceFaceEvidence {
  readonly surface: HarnessComponentKey;
  /** `config.enabledSurfaces` contains this surface (informative, NOT evidence). */
  readonly configured: boolean;
  readonly availability: SurfaceAvailability;
  readonly mechanism: SurfaceMechanism;
  /** The host adapter method the mount would call. */
  readonly hostMethod: string;
  /** True when the resolved adapter exposes that method as a function. */
  readonly seamPresent: boolean;
  /** Concrete, bounded probe evidence for this row. */
  readonly evidence: string;
  /** Why the face is not `native`, when it is not. Never empty in that case. */
  readonly limitation?: string;
}

/** The whole matrix plus the context facts that shaped it. */
export interface SurfaceMatrixReport {
  readonly capturedAt: string;
  /** Host adapter the plugin would resolve under this context. */
  readonly hostAdapterSource: string;
  /**
   * What `resolveHostAdapter` (the production capability order) picked on the
   * SAME context, recorded so a reader can see why the smoke's adapter differs.
   */
  readonly resolveHostAdapterSource?: string;
  /** Why the smoke's adapter is (or is not) the production resolution. */
  readonly resolveNote?: string;
  readonly hookDetected: boolean;
  /** Hook events the adapter accepted (payload-free names only). */
  readonly installedHookEvents: readonly string[];
  /** Structural Cordis seams discovered on the context. */
  readonly structuralSeams: number;
  /** What kind of context the probe had. Recorded so a reader can weigh the limits. */
  readonly contextKind: 'bare-cordis-context' | 'not-run';
  readonly faces: readonly SurfaceFaceEvidence[];
  /** Coherence problems (a face missing, a contradiction). Fails the row. */
  readonly problems: readonly string[];
}

/** Host methods the hook adapter implements NATIVELY (not via the fallback). */
export const HOOK_NATIVE_METHODS: readonly string[] = ['registerPromptSegment', 'registerGuardrails', 'mountMiddleware'];

/** Host-real hook event that proves each hook-native method, for the evidence column. */
const HOOK_EVENT_BY_METHOD: Readonly<Record<string, string>> = {
  registerPromptSegment: 'system-prompt/assemble',
  registerGuardrails: 'tools/pre-execute',
  mountMiddleware: 'agent/pre-step'
};

export interface SurfaceMatrixInput {
  readonly capturedAt: string;
  readonly adapter: CordisHostAdapter | undefined;
  readonly hostAdapterSource: string;
  readonly hookDetected: boolean;
  readonly installedHookEvents?: readonly string[];
  readonly structuralSeams: number;
  readonly enabledSurfaces: readonly string[];
  /** Override for tests; defaults to the smoke's bare-context methodology. */
  readonly contextKind?: 'bare-cordis-context' | 'not-run';
  /** What production `resolveHostAdapter` picked on the same context (if run). */
  readonly resolveHostAdapterSource?: string;
  readonly resolveNote?: string;
  /** Host-real dispatch evidence from the hook probe (manifest source). */
  readonly hookEvidence?: readonly { readonly event: string; readonly dispatched: boolean; readonly payloadFields: readonly string[] }[];
}

/**
 * Classify all eight surfaces from ONE resolved adapter.
 *
 * The rules are ordered so that a less capable source can never be reported as
 * a more capable one:
 *   1. no adapter at all           -> every face `not-run`;
 *   2. method absent on the adapter:
 *        - hook adapter (forwarding is conditional) -> `not-run` (the bare ctx
 *          may simply not expose the structural seam; absence is unobservable),
 *        - any other adapter        -> `unavailable` (the adapter is the whole
 *          story, so a missing method is definitive);
 *   3. method present:
 *        - dsh-hooks + hook-native method -> `native` / dsh-hook,
 *        - dsh-hooks otherwise            -> `native` / cordis-ctx-seam,
 *        - context                        -> `native` / cordis-ctx-seam,
 *        - injected                       -> `native` / injected-adapter,
 *        - in-memory                      -> `fallback` / in-memory-reference.
 */
export function classifySurfaceMatrix(input: SurfaceMatrixInput): SurfaceMatrixReport {
  const problems: string[] = [];
  const enabled = new Set(input.enabledSurfaces);
  const installedHooks = input.installedHookEvents ?? [];
  const contextKind = input.contextKind ?? 'bare-cordis-context';
  const adapter = input.adapter;

  if (adapter === undefined) {
    return {
      capturedAt: input.capturedAt,
      hostAdapterSource: 'not-run',
      ...(input.resolveHostAdapterSource === undefined ? {} : { resolveHostAdapterSource: input.resolveHostAdapterSource }),
      ...(input.resolveNote === undefined ? {} : { resolveNote: input.resolveNote }),
      hookDetected: false,
      installedHookEvents: [],
      structuralSeams: 0,
      contextKind: 'not-run',
      faces: HARNESS_COMPONENT_KEYS.map((surface) => ({
        surface,
        configured: enabled.has(surface),
        availability: 'not-run',
        mechanism: 'not-observed',
        hostMethod: String(SURFACE_HOST_METHOD[surface]),
        seamPresent: false,
        evidence: 'the host smoke did not resolve a host adapter, so no surface was probed',
        limitation: 'no adapter (the in-host probe did not run or threw)'
      })),
      problems: ['no host adapter was resolved; the eight-surface matrix is not-run']
    };
  }

  if (!input.hookDetected && input.hostAdapterSource === 'dsh-hooks') {
    problems.push('hostAdapterSource is dsh-hooks but the hook detection signal is false (contradiction)');
  }

  const faces = HARNESS_COMPONENT_KEYS.map((surface): SurfaceFaceEvidence => {
    const hostMethod = String(SURFACE_HOST_METHOD[surface]);
    const method = (adapter as unknown as Record<string, unknown>)[hostMethod];
    const seamPresent = typeof method === 'function';
    const dispatchForMethod = input.hookEvidence?.find((entry) => HOOK_EVENT_BY_METHOD[hostMethod] === entry.event);
    const dispatchNote =
      dispatchForMethod === undefined
        ? ''
        : ' dispatch[' + dispatchForMethod.event + ']=' + String(dispatchForMethod.dispatched) +
          ' payloadFields=' + String(dispatchForMethod.payloadFields.length);
    const base = {
      surface,
      configured: enabled.has(surface),
      hostMethod,
      seamPresent,
      evidence:
        'adapter=' + input.hostAdapterSource +
        ' method=' + hostMethod +
        ' present=' + String(seamPresent) +
        ' structuralSeams=' + String(input.structuralSeams) +
        ' ctx=' + contextKind +
        dispatchNote
    };

    if (!seamPresent) {
      if (input.hostAdapterSource === 'dsh-hooks') {
        return {
          ...base,
          availability: 'not-run',
          mechanism: 'not-observed',
          limitation:
            'the dsh-hooks adapter forwards this seam only when the context exposes it; the bare Cordis Context used by this runner did not, so mountability was NOT observed (harness limitation, not proof that the host lacks it)'
        };
      }
      return {
        ...base,
        availability: 'unavailable',
        mechanism: 'none',
        limitation: 'the resolved adapter exposes no ' + hostMethod + ' seam, so this surface cannot be mounted'
      };
    }

    if (input.hostAdapterSource === 'in-memory') {
      return {
        ...base,
        availability: 'fallback',
        mechanism: 'in-memory-reference',
        limitation: 'served by the plugin in-process reference adapter; this is NOT a host capability'
      };
    }

    if (input.hostAdapterSource === 'dsh-hooks') {
      if (HOOK_NATIVE_METHODS.includes(hostMethod)) {
        return {
          ...base,
          availability: 'native',
          mechanism: 'dsh-hook',
          evidence: base.evidence + ' hookEvents=' + String(installedHooks.length)
        };
      }
      return {
        ...base,
        availability: 'native',
        mechanism: 'cordis-ctx-seam'
      };
    }

    if (input.hostAdapterSource === 'injected') {
      return {
        ...base,
        availability: 'native',
        mechanism: 'injected-adapter',
        limitation: 'the caller injected this adapter; native refers to the adapter contract, not to a probed install'
      };
    }

    // 'context': the structural Cordis seams discovered on the host context.
    return { ...base, availability: 'native', mechanism: 'cordis-ctx-seam' };
  });

  // Coherence: every component key must appear exactly once.
  const seen = new Set<string>();
  for (const face of faces) {
    if (seen.has(face.surface)) {
      problems.push('duplicate surface ' + face.surface);
    }
    seen.add(face.surface);
  }
  for (const surface of HARNESS_COMPONENT_KEYS) {
    if (!seen.has(surface)) {
      problems.push('missing surface ' + surface);
    }
  }
  if (input.enabledSurfaces.length > 0 && input.enabledSurfaces.length !== HARNESS_COMPONENT_KEYS.length) {
    // Not a defect: enabledSurfaces is a subset by design. Recorded for the reader.
  }

  return {
    capturedAt: input.capturedAt,
    hostAdapterSource: input.hostAdapterSource,
    ...(input.resolveHostAdapterSource === undefined ? {} : { resolveHostAdapterSource: input.resolveHostAdapterSource }),
    ...(input.resolveNote === undefined ? {} : { resolveNote: input.resolveNote }),
    hookDetected: input.hookDetected,
    installedHookEvents: [...installedHooks],
    structuralSeams: input.structuralSeams,
    contextKind,
    faces,
    problems
  };
}

/** Counts per availability value, computed so the report cannot drift from the rows. */
export function countSurfaceAvailability(
  matrix: SurfaceMatrixReport
): Record<SurfaceAvailability, number> {
  const counts: Record<SurfaceAvailability, number> = {
    native: 0,
    fallback: 0,
    unavailable: 0,
    'not-run': 0
  };
  for (const face of matrix.faces) {
    counts[face.availability] += 1;
  }
  return counts;
}

/**
 * Validate the matrix before it reaches the report.
 *
 * Fails closed on the two ways this evidence can lie: a missing face, or a
 * `native` row without a present seam / concrete evidence.
 */
export function validateSurfaceMatrix(matrix: SurfaceMatrixReport): readonly string[] {
  const problems = [...matrix.problems];
  if (matrix.faces.length !== HARNESS_COMPONENT_KEYS.length) {
    problems.push(
      'the matrix must classify all ' + String(HARNESS_COMPONENT_KEYS.length) + ' surfaces, got ' + String(matrix.faces.length)
    );
  }
  for (const face of matrix.faces) {
    if (face.availability === 'native' && face.seamPresent !== true) {
      problems.push('surface ' + face.surface + ' is native but its seam is not present');
    }
    if (face.availability !== 'native' && (face.limitation ?? '').trim().length === 0) {
      problems.push('surface ' + face.surface + ' is ' + face.availability + ' without a limitation/reason');
    }
    if (face.evidence.trim().length === 0) {
      problems.push('surface ' + face.surface + ' carries no probe evidence');
    }
  }
  return problems;
}

/** Render the matrix as a markdown section (bounded cells, no payloads). */
export function renderSurfaceMatrix(matrix: SurfaceMatrixReport): string {
  const counts = countSurfaceAvailability(matrix);
  const lines: string[] = [];
  lines.push('');
  lines.push('## 八表面逐面分类（P1-1 / A-t10-3）');
  lines.push('');
  lines.push(
    '每一面只按探针观测到的证据分类：`native` = 宿主自身机制（hook 监听或 Cordis ctx 服务 seam）；' +
      '`fallback` = 插件进程内参考实现；`unavailable` = 适配器确定没有该 seam；' +
      '`not-run` = 本次观测不到（限制条件写在 limitation 列，不得读成 native）。'
  );
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| :-- | :-- |');
  lines.push('| 采集时间 | ' + matrix.capturedAt + ' |');
  lines.push('| 解析出的适配器 | `' + matrix.hostAdapterSource + '` |');
  if (matrix.resolveHostAdapterSource !== undefined) {
    lines.push('| 生产解析 `resolveHostAdapter`（同上下文） | `' + matrix.resolveHostAdapterSource + '` |');
  }
  lines.push('| 检测到 DSH hook 宿主 | ' + String(matrix.hookDetected) + ' |');
  lines.push('| 已安装 hook 事件 | ' + (matrix.installedHookEvents.length === 0 ? '（无）' : '`' + matrix.installedHookEvents.join('`, `') + '`') + ' |');
  lines.push('| 发现的 Cordis 结构 seam 数 | ' + String(matrix.structuralSeams) + ' |');
  lines.push('| 探针所用上下文 | `' + matrix.contextKind + '` |');
  lines.push(
    '| 合计 | native=' + String(counts.native) + ' fallback=' + String(counts.fallback) +
      ' unavailable=' + String(counts.unavailable) + ' not-run=' + String(counts['not-run']) + ' |'
  );
  lines.push('');
  lines.push('| surface | configured | availability | 机制 | 宿主方法 | 证据 | limitation |');
  lines.push('| :-- | :-- | :-- | :-- | :-- | :-- | :-- |');
  for (const face of matrix.faces) {
    lines.push(
      '| `' + face.surface + '` | ' + String(face.configured) + ' | **' + face.availability + '** | `' +
        face.mechanism + '` | `' + face.hostMethod + '` | `' + cellText(face.evidence) + '` | ' +
        (face.limitation === undefined ? '—' : cellText(face.limitation)) + ' |'
    );
  }
  lines.push('');
  lines.push(
    '**限制条件（必须随本表一起引用）**：本 runner 在安装宿主内构造的是裸 Cordis Context；' +
      '宿主把 tools/skills/subagents 等服务注入的是插件被 apply 时的上下文。因此 `not-run` 表示' +
      '“本次 harness 观测不到该面”，不是“宿主没有该面”；把它写成 `native` 或 `unavailable` 都是超出证据。' +
      '逐面 evidence 列给出产生判定的具体字段（adapter/method/present/structuralSeams/ctx），' +
      'hook 型面另附 manifest 的真实 dispatch 事实。' +
      (matrix.resolveNote === undefined ? '' : ' ' + matrix.resolveNote)
  );
  lines.push('');
  return lines.join('\n');
}

/** `|`-safe, newline-collapsed cell. */
function cellText(value: string): string {
  return value.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

/** The read-only status entry, structurally typed so this module needs no entrypoint import. */
export interface SurfaceStatusEntry {
  readonly surface: string;
  readonly enabled: boolean;
  readonly mountable: boolean;
  readonly lastMountResult?: { readonly ok: boolean; readonly code?: string };
  readonly seamUnavailable?: number;
  readonly cacheRead: 'unknown';
}

/**
 * Render the plugin handle's read-only surface status (rev5 P1-2) as a table.
 *
 * Rendered separately from the probe matrix because the two answer different
 * questions: the matrix says what the ADAPTER exposes (a compatibility fact),
 * the status says what the PLUGIN will report to a host page (a runtime fact).
 * A `mountable` row next to an `unmeasured` lastMountResult is the honest
 * combination — an omitted cell means "no attempt was observed", never "ok".
 */
export function renderSurfaceStatusSnapshot(statuses: readonly SurfaceStatusEntry[]): string {
  const lines: string[] = [];
  const observed = statuses.filter((entry) => 'lastMountResult' in entry).length;
  lines.push('');
  lines.push('## 插件只读状态聚合（P1-2 / A-t10-2）');
  lines.push('');
  lines.push('`enabled` = 配置事实；`mountable` = 适配器事实；`lastMountResult`/`seamUnavailable` 只在有挂载记录时出现（无记录 = 未观测，不是 0）；`cacheRead` 本进程无测量点，恒为 `unknown`。');
  lines.push('');
  lines.push('| surface | enabled | mountable | lastMountResult | seamUnavailable | cacheRead |');
  lines.push('| :-- | :-- | :-- | :-- | :-- | :-- |');
  for (const entry of statuses) {
    lines.push(
      '| `' + entry.surface + '` | ' + String(entry.enabled) + ' | ' + String(entry.mountable) + ' | ' +
        (entry.lastMountResult === undefined
          ? '未观测'
          : (entry.lastMountResult.ok ? 'ok' : 'failed:' + (entry.lastMountResult.code ?? 'unknown'))) +
        ' | ' + (entry.seamUnavailable === undefined ? '未观测' : String(entry.seamUnavailable)) +
        ' | `' + entry.cacheRead + '` |'
    );
  }
  lines.push('');
  lines.push(
    '| 合计 | enabled=' + String(statuses.filter((entry) => entry.enabled).length) +
      ' mountable=' + String(statuses.filter((entry) => entry.mountable).length) +
      ' 有挂载记录=' + String(observed) + ' / ' + String(statuses.length) + ' |  |  |  |  |'
  );
  lines.push('');
  return lines.join('\n');
}

/** Validate the status snapshot against the matrix vocabulary (fails closed). */
export function validateSurfaceStatusSnapshot(statuses: readonly SurfaceStatusEntry[]): readonly string[] {
  const problems: string[] = [];
  if (statuses.length !== HARNESS_COMPONENT_KEYS.length) {
    problems.push('the status snapshot must cover ' + String(HARNESS_COMPONENT_KEYS.length) + ' surfaces, got ' + String(statuses.length));
  }
  const surfaces = new Set<string>();
  for (const entry of statuses) {
    if (surfaces.has(entry.surface)) {
      problems.push('duplicate status surface ' + entry.surface);
    }
    surfaces.add(entry.surface);
    if (entry.cacheRead !== 'unknown') {
      problems.push('surface ' + entry.surface + ' reports cacheRead=' + String(entry.cacheRead) + ' but no read cache is measured in this process');
    }
    if (!entry.mountable && entry.lastMountResult?.ok === true) {
      problems.push('surface ' + entry.surface + ' reports a successful mount while not mountable (contradiction)');
    }
    if ('seamUnavailable' in entry && entry.lastMountResult === undefined) {
      problems.push('surface ' + entry.surface + ' counts seam_unavailable without a last mount result');
    }
  }
  return problems;
}
