/**
 * Eight-surface patch mounting (ARCHITECTURE.md section 3).
 *
 * Each Harness2 surface maps onto exactly one Cordis capability seam:
 *   system_prompt   -> ctx.prompt.registerSegment('system', ...)
 *   guardrails      -> ctx.prompt.registerSegment('guardrails', ...) + ctx.permissions
 *   memory          -> ctx.evoMemory.createScopedView(branchId)
 *   tool_guidance   -> ctx.tools.patchDescriptions(...)
 *   skills          -> ctx.skills.mountDynamic(...)
 *   scripts         -> ctx.sandbox.mountScript(path, code)
 *   subagents       -> ctx.subagents.register(spec)
 *   plugins         -> ctx.middleware.use(hookFn)
 *
 * Mounting is ordered by HARNESS_COMPONENT_KEYS, allocates fresh spec arrays per
 * mount, and always fails loudly when a surface has no edit or a seam is missing.
 * Rollback of a partially mounted patch disposes everything already mounted in
 * reverse order before the original error is rethrown.
 */
import {
  HARNESS_COMPONENT_KEYS,
  type EightSurfacePatch,
  type GuardrailsSurfaceEdit,
  type HarnessComponentKey,
  type MemorySurfaceEdit,
  type PluginsSurfaceEdit,
  type ScriptsSurfaceEdit,
  type SkillsSurfaceEdit,
  type SubagentsSurfaceEdit,
  type SupportedSurfacePayload,
  type SystemPromptSurfaceEdit,
  type ToolGuidanceSurfaceEdit
} from '../types/contracts';
import type { DisposableLike, DisposalFailure, DisposableRegistry } from './disposable-registry';
import type {
  CordisHostAdapter,
  HostDisposer,
  HostGuardrailsSpec,
  HostMemoryScopeSpec,
  HostMiddlewareSpec,
  HostPromptSegmentSpec,
  HostScriptsSpec,
  HostSkillsSpec,
  HostSubagentsSpec,
  HostToolGuidanceSpec
} from './host-adapter';
import { CordisSeamError } from './errors';

/** Stable mount order for the eight surfaces. */
export const SURFACE_MOUNT_ORDER: readonly HarnessComponentKey[] = HARNESS_COMPONENT_KEYS;

/** Host adapter method that implements each surface, for error reporting. */
export const SURFACE_HOST_METHOD: Readonly<Record<HarnessComponentKey, keyof CordisHostAdapter>> = {
  system_prompt: 'registerPromptSegment',
  guardrails: 'registerGuardrails',
  memory: 'registerMemoryScope',
  tool_guidance: 'patchToolGuidance',
  skills: 'mountSkills',
  scripts: 'mountScripts',
  subagents: 'registerSubagents',
  plugins: 'mountMiddleware'
};

/** Identity of the branch/patch a mount belongs to. */
export interface SurfaceMountContext {
  readonly sessionId: string;
  readonly branchId: string;
  readonly namespace: string;
  readonly patchId: string;
}

/** Handle for one mounted surface; dispose is idempotent. */
export interface SurfaceMountHandle extends DisposableLike {
  readonly surface: HarnessComponentKey;
  readonly surfaceId: string;
  readonly label: string;
  readonly active: boolean;
  dispose(): Promise<void>;
}

/** Deterministic, branch-unique id for one mounted surface. */
export function surfaceIdFor(context: SurfaceMountContext, key: HarnessComponentKey): string {
  return context.namespace + '#' + key;
}

/** Default prompt segment name when the edit does not name one. */
export function defaultPromptSegment(key: HarnessComponentKey): string {
  return 'evo-harness-' + key;
}

function copyArray<T>(items: readonly T[] | undefined): T[] {
  return items === undefined ? [] : items.slice();
}

function requireSeam<T>(
  host: CordisHostAdapter,
  key: HarnessComponentKey,
  method: T | undefined,
  branchId: string
): T {
  if (method === undefined) {
    throw new CordisSeamError(
      'Host adapter does not implement "' + String(SURFACE_HOST_METHOD[key]) +
        '" required by surface "' + key + '".',
      { code: 'seam_unavailable', surface: key, branchId }
    );
  }
  return method;
}

/** Normalize a host seam result into an idempotent disposer. */
function toHostDisposer(result: HostDisposer | (() => void | Promise<void>) | undefined | null): HostDisposer {
  if (result === null || result === undefined) {
    return { dispose: (): void => undefined };
  }
  if (typeof result === 'function') {
    return { dispose: result };
  }
  if (typeof result.dispose === 'function') {
    return result;
  }
  throw new CordisSeamError('Host seam returned a value without dispose().', { code: 'surface_mount_failed' });
}

function wrapHandle(
  key: HarnessComponentKey,
  surfaceId: string,
  disposer: HostDisposer
): SurfaceMountHandle {
  let active = true;
  const handle: SurfaceMountHandle = {
    surface: key,
    surfaceId,
    label: 'surface:' + key,
    get active(): boolean {
      return active;
    },
    dispose: async (): Promise<void> => {
      if (!active) {
        return;
      }
      active = false;
      await disposer.dispose();
    }
  };
  return handle;
}

/**
 * Mount one surface edit through its host seam. Throws seam_unavailable when the
 * adapter lacks the seam and surface_kind_mismatch when the edit's discriminant
 * does not match the surface key.
 */
export async function mountSurface(
  host: CordisHostAdapter,
  key: HarnessComponentKey,
  edit: SupportedSurfacePayload | undefined,
  context: SurfaceMountContext
): Promise<SurfaceMountHandle> {
  if (edit === undefined) {
    throw new CordisSeamError('No edit supplied for surface "' + key + '".', {
      code: 'invalid_surface_edit',
      surface: key,
      branchId: context.branchId,
      patchId: context.patchId
    });
  }
  if (edit.kind !== key) {
    throw new CordisSeamError(
      'Surface edit kind "' + edit.kind + '" does not match surface key "' + key + '".',
      {
        code: 'surface_kind_mismatch',
        surface: key,
        branchId: context.branchId,
        patchId: context.patchId,
        details: { editKind: edit.kind }
      }
    );
  }

  const surfaceId = surfaceIdFor(context, key);
  const base = {
    surfaceId,
    branchId: context.branchId,
    sessionId: context.sessionId,
    namespace: context.namespace
  };
  let result: HostDisposer | undefined;

  switch (key) {
    case 'system_prompt': {
      const typed = edit as SystemPromptSurfaceEdit;
      const seam = requireSeam(host, key, host.registerPromptSegment, context.branchId);
      const spec: HostPromptSegmentSpec = {
        ...base,
        segment: typed.segment ?? defaultPromptSegment(key),
        mode: typed.mode,
        content: typed.content,
        priority: typed.priority
      };
      result = await seam(spec);
      break;
    }
    case 'guardrails': {
      const typed = edit as GuardrailsSurfaceEdit;
      const seam = requireSeam(host, key, host.registerGuardrails, context.branchId);
      const spec: HostGuardrailsSpec = {
        ...base,
        appendRules: copyArray(typed.appendRules),
        forbiddenActions: copyArray(typed.forbiddenActions),
        formatContract: typed.formatContract,
        toolPreconditions: copyArray(typed.toolPreconditions)
      };
      result = await seam(spec);
      break;
    }
    case 'memory': {
      const typed = edit as MemorySurfaceEdit;
      const seam = requireSeam(host, key, host.registerMemoryScope, context.branchId);
      const spec: HostMemoryScopeSpec = {
        ...base,
        scopedViewId: typed.scopedViewId ?? context.namespace,
        workingNotes: copyArray(typed.workingNotes),
        recallTags: copyArray(typed.recallTags)
      };
      result = await seam(spec);
      break;
    }
    case 'tool_guidance': {
      const typed = edit as ToolGuidanceSurfaceEdit;
      const seam = requireSeam(host, key, host.patchToolGuidance, context.branchId);
      const spec: HostToolGuidanceSpec = {
        ...base,
        descriptions: { ...typed.descriptions },
        priorityOrder: typed.priorityOrder === undefined ? undefined : copyArray(typed.priorityOrder),
        examples: typed.examples === undefined ? undefined : copyArray(typed.examples)
      };
      result = await seam(spec);
      break;
    }
    case 'skills': {
      const typed = edit as SkillsSurfaceEdit;
      const seam = requireSeam(host, key, host.mountSkills, context.branchId);
      const spec: HostSkillsSpec = { ...base, skills: copyArray(typed.skills) };
      result = await seam(spec);
      break;
    }
    case 'scripts': {
      const typed = edit as ScriptsSurfaceEdit;
      const seam = requireSeam(host, key, host.mountScripts, context.branchId);
      const spec: HostScriptsSpec = { ...base, scripts: copyArray(typed.scripts) };
      result = await seam(spec);
      break;
    }
    case 'subagents': {
      const typed = edit as SubagentsSurfaceEdit;
      const seam = requireSeam(host, key, host.registerSubagents, context.branchId);
      const spec: HostSubagentsSpec = { ...base, agents: copyArray(typed.agents) };
      result = await seam(spec);
      break;
    }
    case 'plugins': {
      const typed = edit as PluginsSurfaceEdit;
      const seam = requireSeam(host, key, host.mountMiddleware, context.branchId);
      const spec: HostMiddlewareSpec = { ...base, middleware: copyArray(typed.middleware) };
      result = await seam(spec);
      break;
    }
    default: {
      const unreachable: never = key;
      throw new CordisSeamError('Unsupported surface key ' + String(unreachable) + '.', {
        code: 'invalid_surface_edit',
        branchId: context.branchId
      });
    }
  }

  return wrapHandle(key, surfaceId, toHostDisposer(result));
}

/** Mounted surface set produced by mountEightSurfaces. */
export interface MountedSurfaces {
  readonly keys: readonly HarnessComponentKey[];
  readonly handles: readonly SurfaceMountHandle[];
  readonly skipped: readonly HarnessComponentKey[];
}

/** Options controlling which surfaces are mounted and where disposers register. */
export interface MountEightSurfacesOptions {
  readonly registry?: DisposableRegistry;
  readonly enabledSurfaces?: readonly HarnessComponentKey[];
}

/**
 * Dispose mounted handles in reverse order, collecting failures.
 * Never throws, so callers can always surface the original mount error.
 */
export async function rollbackMounts(
  handles: readonly SurfaceMountHandle[]
): Promise<readonly DisposalFailure[]> {
  const failures: DisposalFailure[] = [];
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    const handle = handles[index];
    if (handle === undefined) {
      continue;
    }
    try {
      await handle.dispose();
    } catch (error) {
      failures.push({ label: handle.label, error });
    }
  }
  return failures;
}

/**
 * Mount every surface edit present in the patch, in HARNESS_COMPONENT_KEYS order.
 * Surfaces without an edit (or filtered out by enabledSurfaces) are reported as
 * skipped. A failure mid-way disposes everything already mounted.
 */
export async function mountEightSurfaces(
  host: CordisHostAdapter,
  patch: EightSurfacePatch,
  context: SurfaceMountContext,
  options: MountEightSurfacesOptions = {}
): Promise<MountedSurfaces> {
  const allowed =
    options.enabledSurfaces === undefined ? null : new Set<HarnessComponentKey>(options.enabledSurfaces);
  const handles: SurfaceMountHandle[] = [];
  const keys: HarnessComponentKey[] = [];
  const skipped: HarnessComponentKey[] = [];

  for (const key of HARNESS_COMPONENT_KEYS) {
    const edit = patch.edits[key];
    if (edit === undefined || (allowed !== null && !allowed.has(key))) {
      skipped.push(key);
      continue;
    }
    try {
      const handle = await mountSurface(host, key, edit, context);
      handles.push(handle);
      keys.push(key);
      if (options.registry !== undefined) {
        options.registry.add(handle.label, handle);
      }
    } catch (error) {
      const rollbackFailures = await rollbackMounts(handles);
      if (error instanceof CordisSeamError) {
        throw error;
      }
      throw new CordisSeamError('Failed to mount surface "' + key + '".', {
        code: 'surface_mount_failed',
        surface: key,
        branchId: context.branchId,
        patchId: context.patchId,
        cause: error,
        details: { rollbackFailures: rollbackFailures.map((failure) => failure.label) }
      });
    }
  }

  return { keys, handles, skipped };
}
