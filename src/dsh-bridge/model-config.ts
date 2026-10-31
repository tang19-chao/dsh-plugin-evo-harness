/**
 * Schemastery config fragment for the optional secondary-page model route.
 *
 * DSH SETTINGS-UI FACT (verified against resources/app.asar):
 *  - DSH plugins declare `static Config = z.object({...})` (or an exported
 *    `Config`) built with `@deepseek-ai/schemastery`. See
 *    @deepseek-ai/dsh-agent-default-model, whose fragment is exactly:
 *        z.object({
 *          provider: z.string().required().volatile(),
 *          model: z.string().required().volatile(),
 *          reasoningEffort: z.string().volatile()
 *        })
 *  - `.volatile()` is REQUIRED for a field to be writable from the settings UI
 *    and persisted by the configuration editor: a plain (non-volatile) field is
 *    validated once and frozen into the fiber config, so the page cannot save a
 *    change to it. Cordis resolves the schema through the Standard Schema
 *    protocol (`runtime.Config['~standard'].validate(config)`), which
 *    schemastery implements.
 *  - Defaults here follow the verified DSH default route qodercn / dfmodel
 *    (DeepSeek-Flash; reasoning efforts high | max | low, default max).
 *
 * CURRENT FACTS (measured 2026-10-30, rev5 P0-6; see the correction register
 * below): this repository DECLARES the dependency
 * (`package.json` dependencies: `@deepseek-ai/schemastery@3.18.4`), and in THIS
 * checkout a plain `import('@deepseek-ai/schemastery')` resolves (exit 0). The
 * next paragraph describes the HOST INSTALL case - a symlinked plugin directory
 * without its own `node_modules` - which is why the structural loader is kept.
 * It is NOT a claim that the dependency is missing from this repository; an
 * earlier revision of this header said the integrator still had to install it,
 * which is the stale wording this comment records.
 *
 * WHY THIS FILE DOES NOT IMPORT SCHEMASTERY STATICALLY (verified, not a guess):
 * ESM resolution for a bare specifier walks up from the REAL path of the
 * importing file. A host may install this plugin as a SYMLINK
 * (<profile>/node_modules/dsh-plugin-evo-harness -> <plugin checkout>), where
 * `@deepseek-ai/schemastery` is NOT installed; a static import then fails with
 * ERR_MODULE_NOT_FOUND at load time AND breaks `pnpm run build` (esbuild
 * --bundle cannot resolve it). A runtime probe confirmed the failure for both
 * the real path and the symlinked path in that install layout.
 *
 * Therefore the fragment is built through an injected, structurally typed
 * schemastery instance (`createModelRouteSchema(z)`) and the module exposes a
 * guarded dynamic loader (`loadSchemastery()`) for hosts that resolve the
 * package. The integrator attaches the result where DSH reads the plugin Config
 * and must make `@deepseek-ai/schemastery` resolvable from the installed copy
 * (it is already a declared dependency of this repository); both of those files
 * are outside src/dsh-bridge/**.
 *
 * DOC-DRIFT REGISTER (bidirectional pointer, rev5 P0-6 / P1-4):
 *   forward: `docs/reports/p0-evidence-correction.md` §C-5 records the stale
 *            "install it" phrasing, the measured resolution evidence and this
 *            file's header range.
 *   reverse: this header names that register (the edge the register points back
 *            to is here). The H-3 terminology drift that the register also
 *            covers is registered in ADR 0007 §4; that ADR is sha256-pinned by
 *            `tests/unit/jitrl/p6-pareto-budget.test.ts`, so its own pointer
 *            edges are frozen and cannot be edited - the register documents the
 *            pair instead of rewriting the pinned file.
 */

/** Verified default route for the secondary model page. */
export const MODEL_ROUTE_DEFAULTS = {
  provider: 'qodercn',
  model: 'dfmodel',
  reasoningEffort: 'max'
} as const;

/** Verified reasoning efforts advertised for the default route. */
export const MODEL_ROUTE_EFFORTS = ['high', 'max', 'low'] as const;

/** The modelRoute group this fragment validates. */
export interface ModelRouteConfig {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** One declared field of the modelRoute fragment. */
export interface ModelRouteFieldSpec {
  readonly name: keyof ModelRouteConfig;
  readonly required: boolean;
  readonly defaultValue?: string;
  readonly description: string;
}

/**
 * Field table for the fragment. Every entry must be marked volatile when the
 * schema is built; this table is the single source for that requirement so the
 * three fields cannot drift apart.
 */
export const MODEL_ROUTE_FIELDS: readonly ModelRouteFieldSpec[] = [
  {
    name: 'provider',
    required: true,
    defaultValue: MODEL_ROUTE_DEFAULTS.provider,
    description: 'DSH LLM provider route id (ctx.llm.listProviders())'
  },
  {
    name: 'model',
    required: true,
    defaultValue: MODEL_ROUTE_DEFAULTS.model,
    description: 'Model id advertised by the provider (ctx.llm.listModels(provider))'
  },
  {
    name: 'reasoningEffort',
    required: false,
    defaultValue: MODEL_ROUTE_DEFAULTS.reasoningEffort,
    description: 'Adapter-owned reasoning effort: ' + MODEL_ROUTE_EFFORTS.join(' | ')
  }
];

// ---------------------------------------------------------------------------
// Structural schemastery boundary
// ---------------------------------------------------------------------------

/**
 * The subset of schemastery this fragment uses. Declared structurally because
 * the package cannot be imported from this install (see the header).
 */
export interface SchemasteryStringSchema {
  volatile(): SchemasteryStringSchema;
  required(): SchemasteryStringSchema;
  default(value: string): SchemasteryStringSchema;
  description(text: string): SchemasteryStringSchema;
}

/** A schemastery object schema; the exact type is the library's own. */
export interface SchemasteryObjectSchema {
  readonly [key: string]: unknown;
  volatile?(): SchemasteryObjectSchema;
  required?(): SchemasteryObjectSchema;
  description?(text: string): SchemasteryObjectSchema;
}

/** Structural view of the schemastery module surface this fragment needs. */
export interface SchemasteryLike {
  string(): SchemasteryStringSchema;
  object(dict: Record<string, unknown>): SchemasteryObjectSchema;
}

/** True when a value looks like a usable schemastery module. */
export function isSchemasteryLike(value: unknown): value is SchemasteryLike {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  const candidate = (record.default ?? record) as Record<string, unknown>;
  return typeof candidate.string === 'function' && typeof candidate.object === 'function';
}

/** The package name this module expects the host to resolve. */
export const SCHEMASTERY_PACKAGE = '@deepseek-ai/schemastery';

/** Error reported when the schemastery package cannot be resolved. */
export class SchemasteryUnavailableError extends Error {
  readonly code = 'SCHEMASTERY_UNAVAILABLE' as const;

  constructor(detail: string) {
    super('dsh-plugin-evo-harness: ' + detail);
    this.name = 'SchemasteryUnavailableError';
  }
}

/**
 * Resolve the schemastery module at runtime.
 *
 * The specifier is assembled from a constant so no bundler rewrites it into an
 * eager dependency: a build must not fail when the package is absent from this
 * install. Returns undefined instead of throwing when it cannot be resolved.
 */
export async function loadSchemastery(
  onDiagnostic?: (message: string) => void
): Promise<SchemasteryLike | undefined> {
  const specifier = SCHEMASTERY_PACKAGE;
  try {
    const loaded: unknown = await import(/* @vite-ignore */ specifier);
    if (isSchemasteryLike(loaded)) {
      return loaded;
    }
    const wrapped = loaded as { default?: unknown };
    if (isSchemasteryLike(wrapped.default)) {
      return wrapped.default as SchemasteryLike;
    }
    onDiagnostic?.(SCHEMASTERY_PACKAGE + ' resolved but does not expose string()/object(); its config was ignored');
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    onDiagnostic?.(
      SCHEMASTERY_PACKAGE + ' is not resolvable from this install (' + reason + '); '
        + 'install it as a dependency so the model-route settings fields become editable'
    );
    return undefined;
  }
}

/**
 * Build the modelRoute Schemastery fragment.
 *
 * Every field is marked volatile, which is what makes it editable from the DSH
 * settings page. `provider` and `model` are also required so a blank value is
 * rejected at validation time instead of dispatching a request with an empty
 * route id.
 */
export function createModelRouteSchema(z: SchemasteryLike): SchemasteryObjectSchema {
  const dict: Record<string, unknown> = {};
  for (const field of MODEL_ROUTE_FIELDS) {
    let schema = z.string();
    if (field.defaultValue !== undefined) {
      schema = schema.default(field.defaultValue);
    }
    if (field.required) {
      schema = schema.required();
    }
    schema = schema.description(field.description);
    schema = schema.volatile();
    dict[field.name] = schema;
  }
  return z.object(dict);
}

/**
 * Build the full plugin Config fragment with the modelRoute group nested under
 * its own key, so the settings page renders one collapsible secondary section
 * instead of three top-level fields.
 *
 * The group is itself volatile: Cordis blocks a volatile field under a volatile
 * parent ("volatile fields require a fixed object path without an enclosing
 * volatile field"), so a *non-volatile* group whose LEAF fields are volatile is
 * the supported placement. `provider`/`model`/`reasoningEffort` are therefore
 * volatile leaves and the group is not wrapped.
 */
export function createModelConfigFragment(z: SchemasteryLike): SchemasteryObjectSchema {
  return z.object({ modelRoute: createModelRouteSchema(z) });
}

// ---------------------------------------------------------------------------
// Runtime reader (works with or without schemastery)
// ---------------------------------------------------------------------------

/** Read one string field of an arbitrary record without letting a proxy throw. */
function readString(source: unknown, key: string): string | undefined {
  if (source === null || typeof source !== 'object') {
    return undefined;
  }
  let value: unknown;
  try {
    value = (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  // A schemastery volatile field parses into a reference exposing get(); the
  // configuration editor also hands back plain strings.
  if (typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    try {
      const inner = (value as { get: () => unknown }).get();
      return typeof inner === 'string' && inner.length > 0 ? inner : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Resolve the effective model route from any config source.
 *
 * Accepts a plain section, a schemastery-validated config (including volatile
 * references), or a nested `{ modelRoute }` group, and falls back per field to
 * MODEL_ROUTE_DEFAULTS. Never throws.
 */
export function resolveModelRouteConfig(section: unknown): ModelRouteConfig & { reasoningEffort: string } {
  const nested =
    section !== null && typeof section === 'object'
      ? (() => {
          try {
            return (section as Record<string, unknown>).modelRoute;
          } catch {
            return undefined;
          }
        })()
      : undefined;
  const source = nested !== null && typeof nested === 'object' ? nested : section;
  return {
    provider: readString(source, 'provider') ?? MODEL_ROUTE_DEFAULTS.provider,
    model: readString(source, 'model') ?? MODEL_ROUTE_DEFAULTS.model,
    reasoningEffort: readString(source, 'reasoningEffort') ?? MODEL_ROUTE_DEFAULTS.reasoningEffort
  };
}
