/**
 * Defensive patch handling shared by branch forking and permanent mounting.
 *
 * A patch handed to the seam layer is treated as untrusted mutable input: it is
 * structurally validated, deep-cloned and deep-frozen so that concurrent
 * branches can never observe each other's edits. Frozen edits make accidental
 * mutation throw in strict mode instead of silently leaking across branches.
 */
import type { EightSurfacePatch, HarnessComponentKey } from '../types/contracts';
import { HARNESS_COMPONENT_KEYS } from '../types/contracts';
import { CordisSeamError } from './errors';

/** Minimal structural validation of an EightSurfacePatch. */
export function assertEightSurfacePatch(
  patch: unknown
): asserts patch is EightSurfacePatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new CordisSeamError('A patch must be a plain object.', { code: 'invalid_request' });
  }
  const candidate = patch as Partial<EightSurfacePatch> & { edits?: unknown };
  for (const field of ['id', 'sessionId', 'branchId'] as const) {
    const value = candidate[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new CordisSeamError('Patch field "' + field + '" must be a non-empty string.', {
        code: 'invalid_request',
        details: { field }
      });
    }
  }
  if (typeof candidate.edits !== 'object' || candidate.edits === null || Array.isArray(candidate.edits)) {
    throw new CordisSeamError('Patch field "edits" must be an object.', {
      code: 'invalid_request',
      patchId: candidate.id
    });
  }
}

/** Deep-freeze plain data (objects, arrays) in place. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  const record = value as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    deepFreeze(record[key]);
  }
  return value;
}

/**
 * Clone a patch, pin it to the branch that will execute it, and deep-freeze it.
 * The returned patch is a distinct object graph per branch, so two concurrent
 * branches never share a mutable edits object.
 */
export function cloneAndFreezePatch(patch: EightSurfacePatch, branchId: string): EightSurfacePatch {
  assertEightSurfacePatch(patch);
  if (typeof branchId !== 'string' || branchId.length === 0) {
    throw new CordisSeamError('branchId must be a non-empty string.', { code: 'invalid_request' });
  }
  const clone = structuredClone(patch) as EightSurfacePatch;
  (clone as { branchId: string }).branchId = branchId;
  return deepFreeze(clone);
}

/** Keys of the eight surfaces that carry an edit in this patch, in mount order. */
export function editedSurfaceKeys(patch: EightSurfacePatch): readonly HarnessComponentKey[] {
  const edits = patch.edits as Readonly<Record<string, unknown>>;
  return HARNESS_COMPONENT_KEYS.filter((key) => edits[key] !== undefined);
}

/** Order-independent normalization of a surface key list. */
export function normalizeSurfaceKeys(
  keys: readonly HarnessComponentKey[]
): readonly HarnessComponentKey[] {
  const wanted = new Set<HarnessComponentKey>(keys);
  return HARNESS_COMPONENT_KEYS.filter((key) => wanted.has(key));
}
