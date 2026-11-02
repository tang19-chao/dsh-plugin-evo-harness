#!/usr/bin/env node
/**
 * Orphan-export gate (audit round 2, §9 batch-2 process improvement).
 *
 * WHAT IT PROVES
 *   Every symbol a `src/**` module EXPORTS has a reader somewhere in `src/**` or
 *   `tests/**`. An exported declaration nothing reads is either dead code (a
 *   refactor left it behind) or a public surface nobody tests.
 *
 * WHAT IT DOES NOT CATCH (stated first, so the gate is not credited with more)
 *   The P0-1 defect that motivated this item was `forwardingModel` /
 *   `forwardingBranch` in `src/index.ts`: module-PRIVATE functions that the
 *   holder wiring never called. A private function has no export to check, so a
 *   purely export-oriented gate cannot see it — `git show HEAD:src/index.ts`
 *   confirms both were `function` (not `export function`) with a single textual
 *   occurrence each. This gate covers the SIBLING shape: an exported
 *   collaborator that loses its caller during a refactor (exactly what
 *   `clients`-style forwarding surfaces look like). Anything stronger needs a
 *   call-graph, not an export scan, and that is a deliberate non-goal.
 *
 * HOW IT DECIDES (conservative, no type checker)
 *   Each `src/**` file is parsed with the TypeScript compiler API and its own
 *   exported declarations are collected: functions, classes, `const`/`let`/`var`
 *   bindings, interfaces, type aliases and enums. For each symbol the gate
 *   searches every file in `src/**` + `tests/**` for identifier occurrences,
 *   counting any occurrence that is not that symbol's own declaration name.
 *   Parsed identifiers — never a text search — so a comment or string literal
 *   cannot fake a reader.
 *
 * TYPE-ONLY RE-EXPORTS: THE STATED口径
 *   Both `export { x } from './x'` and `export type { x } from './x'` put `x`
 *   in the barrel's export clause as a real identifier, so the gate counts them
 *   as readers. `export * from './x'` names no identifier, so a symbol whose
 *   ONLY reader is a star barrel remains an orphan and needs an allowlist entry
 *   that says so. That asymmetry is intentional: a named re-export states which
 *   surface the barrel intends to publish, while a star export publishes
 *   whatever happens to exist — including a leftover nothing imports. Type-only
 *   positions count everywhere (an exported type with no type-position reader
 *   is the same blind spot as an uncalled function).
 *
 * ALLOWLIST
 *   `src/**` exports that legitimately have no in-repo reader: a plugin entry
 *   surface the host imports by path, a contract type a downstream package
 *   consumes, a deliberate test hook. Each entry is { symbol, file, reason }
 *   and the reason must be at least 120 characters, matching the discipline of
 *   tests/unit/meta/no-work-dependency.test.ts. The gate is strict in BOTH
 *   directions: an unlisted orphan fails, and an allowlist entry that no longer
 *   matches an orphan also fails (stale allowlist).
 *
 *   A REASON MUST DESCRIBE THE REALITY OF THIS TREE. Every entry below was
 *   re-verified against the current sources: the symbol has zero importers
 *   inside `src/` and `tests/`, and it is NOT reachable from the package root
 *   (`package.json` `exports` admits only `.` and `./package.json`, and
 *   `src/index.ts` re-exports these modules selectively, not wholesale). None
 *   of them are "used by every driver" or "imported by the eval harness" —
 *   earlier wording claimed exactly that and the claims were false.
 *
 * USAGE
 *   node scripts/eval/check-orphan-exports.mjs [--json] [--root <dir>] [--allowlist <file>]
 *   exit 0 = no orphans, exit 1 = violations, exit 2 = usage/IO error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const MIN_REASON_LENGTH = 120;

/**
 * Production allowlist. Every entry needs a reason of at least 120 characters;
 * the gate fails on an entry whose symbol is no longer an orphan, so this table
 * cannot rot silently.
 */
const DEFAULT_ALLOWLIST = Object.freeze([
  {
    symbol: 'persistExistingTreePool',
    file: 'src/persistence/tree-pool.store.ts',
    reason:
      'Bootstrap helper: fills a TreePoolStore from an already-loaded in-memory pool. The runtime uses ' +
      'createPersistenceRuntime for the same effect, so nothing calls this helper today; it stays exported ' +
      'because a second entry point that skips the runtime wrapper would need it, and it is covered by tests ' +
      'through the persistence barrel only by name, not by call. Re-verify before extending this reason.'
  },
  {
    symbol: 'createPersistentActivePolicy',
    file: 'src/persistence/policy.store.ts',
    reason:
      'Wraps a PolicyStore in the IActivePolicy surface for callers that build the persistence layer ' +
      'themselves. The plugin mounts through createPersistenceRuntime instead, which is why no in-repo caller ' +
      'exists; the export is kept as the documented seam for an embedder-supplied policy store. It is ' +
      'reachable only as an internal path, never from the package entry.'
  },
  {
    symbol: 'removeFileIfExists',
    file: 'src/persistence/data-dir.ts',
    reason:
      'Tolerant unlink helper: returns a boolean instead of throwing on ENOENT, which is the semantics the ' +
      'stores assume. Nothing in this repository calls it; it is exported so a host-side profile cleanup can ' +
      'reuse the same tolerance instead of re-implementing it, and it stays inside the persistence barrel.'
  },
  {
    symbol: 'readOrchestratorMetadata',
    file: 'src/orchestrator.ts',
    reason:
      'Narrowing helper for the metadata bag an orchestrator run attaches to its result, written for a host ' +
      'that decodes lifecycle and stopReason without importing the private record shapes. The plugin entry ' +
      're-exports the orchestrator selectively and does not publish this name, so nothing in src/ or tests/ ' +
      'reads it today; the export remains the documented accessor for that consumer.'
  },
  {
    symbol: 'buildSchemaArgs',
    file: 'src/memory-bridge/spi.ts',
    reason:
      'Schema-aware argument builder for memory-driver tools: it emits only the arguments the backend schema ' +
      'actually declares. No driver family calls it in this tree — the built-in drivers build their arguments ' +
      'inline — so it is kept as the SPI helper a custom-mapped embedder can reuse. Reachable only through the ' +
      'memory-bridge barrel, not from the package entry.'
  },
  {
    symbol: 'payloadOf',
    file: 'src/memory-bridge/drivers/shared.ts',
    reason:
      'Unwraps an MCP tool result into its JSON payload. The driver families in this tree each read the result ' +
      'shape directly, so there is no importer; the helper is exported as the shared primitive a new driver ' +
      'family should use instead of re-deriving the unwrapping rules. It is NOT imported by the existing ' +
      'families — an earlier reason asserted that and it was false.'
  },
  {
    symbol: 'putIfDeclared',
    file: 'src/memory-bridge/drivers/shared.ts',
    reason:
      'Writes an optional argument only when the backend schema declares it. Same situation as payloadOf in ' +
      'the same module: no driver family imports it in this tree, and it is exported as the shared primitive ' +
      'for a custom or future driver rather than because one exists today. The earlier reason claiming every ' +
      'driver family imports it was wrong and is corrected here.'
  },
  {
    symbol: 'boundDriverKindOf',
    file: 'src/memory-bridge/bridge.ts',
    reason:
      'Accessor for the concrete driver kind behind a live bridge, for host code that branches on the driver ' +
      'family. The bridge resolves the kind internally while binding, so no in-repo caller needs this accessor; ' +
      'it is exported through the memory-bridge barrel for host status rendering, not reachable from the ' +
      'package entry.'
  },
  {
    symbol: 'bridgeDriverKind',
    file: 'src/memory-bridge/bridge.ts',
    reason:
      'Binding-kind accessor for a live bridge (as opposed to the concrete driver kind that boundDriverKindOf ' +
      'returns). Kept for host status pages that display the mounted family; the plugin reads the descriptor ' +
      'directly, so nothing in src/ or tests/ imports this name today. Reachable only via the memory-bridge ' +
      'barrel.'
  },
  {
    symbol: 'isDriverKind',
    file: 'src/memory-bridge/auto-discovery.ts',
    reason:
      'Type guard that narrows a MemoryBindingKind to a MemoryDriverKind. Exported for host code that holds a ' +
      'binding kind read from a descriptor and needs to narrow it without importing the driver table. ' +
      'Auto-discovery narrows internally, so no in-repo file calls the guard; it is published through the ' +
      'memory-bridge barrel only.'
  },
  {
    symbol: 'boundDriverKind',
    file: 'src/memory-bridge/auto-discovery.ts',
    reason:
      'Descriptor-level counterpart of the bridge accessor above: reports a descriptor driver kind with a ' +
      'safe fallback for hosts that render driver diagnostics from a descriptor they already hold. The ' +
      'discovery path reads the field directly rather than through this function, hence zero importers in ' +
      'this tree.'
  },
  {
    symbol: 'addSeats',
    file: 'src/ledger/limits.ts',
    reason:
      'Branded arithmetic over ExplorationSeatUnits: adding two seat counts without unwrapping the brand. ' +
      'Seat accounting in the reservation manager adjusts seats inline, so no caller exists; the export keeps ' +
      'downstream seat tooling unit-safe instead of forcing a cast. Published through the ledger barrel, not ' +
      'from the package entry.'
  },
  {
    symbol: 'addCurrency',
    file: 'src/ledger/limits.ts',
    reason:
      'Branded arithmetic over CurrencyMicros, the sanctioned way to total money. The ledger sums inline at ' +
      'each call site and never routes through this helper, which is why it has no importer; it is exported ' +
      'so external budget tooling can add ledger amounts without re-implementing the brand check.'
  },
  {
    symbol: 'policySlotWeights',
    file: 'src/jitrl/index.ts',
    reason:
      'Diagnostic reader for a policy slot weights that never mutates the policy. The kernel derives its own ' +
      'weights during a decision, so nothing in src/ or tests/ reads this function; it is exported so an offline ' +
      'analysis can inspect a policy it already holds. It is NOT imported by the eval harness — the earlier ' +
      'reason said it was and that claim was false.'
  },
  {
    symbol: 'editedSurfaceKeys',
    file: 'src/cordis-seams/patch-utils.ts',
    reason:
      'Patch introspection: lists the eight-surface keys that carry an edit in a patch, in mount order. The ' +
      'seam manager validates patches on mount and does not need to enumerate edited keys first, so no caller ' +
      'exists; exported as the helper an embedder can use to pre-validate a patch against its own allowlist. ' +
      'Reachable only through the cordis-seams barrel.'
  },
  {
    symbol: 'plannedSurfaceKeys',
    file: 'src/cordis-seams/context-forker.ts',
    reason:
      'Fork introspection: lists the surface keys a branch will mount, derivable before mounting so a caller ' +
      'can plan ahead. The forker computes its own mount list internally while creating the branch, so nothing ' +
      'in this tree calls this function; it stays exported for host adapters that need the plan up front. ' +
      'Published through the cordis-seams barrel only.'
  },
  {
    symbol: 'EvoHarnessTrigger',
    file: 'src/index.ts',
    reason:
      'Public alias of TriggerMode exported from the package root "for hosts that resolve the trigger mode ' +
      'themselves" (the comment above the declaration). No file in src/ or tests/ names this alias — the ' +
      'trigger events are consumed through LEGACY_AUTO_FALLBACK_EVENTS and the Config schema — so it is ' +
      'literally unreferenced and is kept only as a documented host-facing alias.'
  },
  // --- Consts / type aliases surfaced when the scan widened to the whole
  // export surface (the header口径). Each one below has exactly ONE textual
  // occurrence in src/ + tests/ — its own declaration — verified by grep, and
  // none is reachable from the package root. They are recorded rather than
  // deleted because deletion is a source change outside this batch's scope; the
  // entry exists so the gate stops being silent about them.
  {
    symbol: 'SURFACE_MOUNT_ORDER',
    file: 'src/cordis-seams/eight-surfaces.ts',
    reason:
      'Alias of HARNESS_COMPONENT_KEYS carrying the stable eight-surface mount order. It has no reader: the ' +
      'mount path and tests/unit/cordis-seams/eight-surfaces.test.ts both use HARNESS_COMPONENT_KEYS ' +
      'directly, so this alias is a second name for the same constant. Kept only because removing it would ' +
      'change the published cordis-seams barrel.'
  },
  {
    symbol: 'AdapterLike',
    file: 'src/dsh-bridge/real-benefit-host-client.ts',
    reason:
      'Structural adapter alias of IModelAdapter. The runner binds adapters against IModelAdapter from ' +
      'types/contracts, so this alias has no reader; it is a convenience name left in place. Not reachable ' +
      'from the package entry — per the exports map only "." exists.'
  },
  {
    symbol: 'DSH_SESSION_EVENT_TYPES',
    file: 'src/host-triggers.ts',
    reason:
      'Declares the session event types this module interprets. Nothing reads the array: the classifier ' +
      'matches the literals inline, so the constant is documentation in value form. A host that wanted to ' +
      'enumerate the handled events would be its intended consumer, and no such consumer exists in this ' +
      'tree.'
  },
  {
    symbol: 'DSH_TURN_END_KINDS',
    file: 'src/host-triggers.ts',
    reason:
      'Declares the verified turn-end reason kinds. Same situation as DSH_SESSION_EVENT_TYPES: the ' +
      'normalizer compares against literals rather than iterating this table, so the constant has no reader ' +
      'and acts as an audited reference list for the DSH catalog values.'
  },
  {
    symbol: 'BackfillFidelity',
    file: 'src/jitrl/backfill.ts',
    reason:
      'Union of the two backfill fidelity labels ("surrogatePrior" / "rescored"). Records are stamped with ' +
      'a reward version instead, so the union is never named as a type; it is kept as documentation of the ' +
      'two legitimate provenance paths described in the comment above it.'
  },
  {
    symbol: 'AugmentedCandidatePayload',
    file: 'src/jitrl/candidate-augmenter.ts',
    reason:
      'Alias of RehydratedAction whose own comment calls it "kept for symmetry with the other kernel ' +
      'modules and for type reuse". No type position in src/ or tests/ names it, so it is a surplus alias ' +
      'with no reader; recorded here rather than deleted in a batch scoped to gates.'
  },
  {
    symbol: 'POLICY_LAYER_LEVELS',
    file: 'src/jitrl/decision-kernel.ts',
    reason:
      'Maps each consumer configuration layer to the level it decides at. The kernel switches on the layer ' +
      'directly instead of looking the level up in this table, so the constant is unreferenced; it remains ' +
      'as the audited statement of the level mapping.'
  },
  {
    symbol: 'LEGACY_EXPERIENCE_SCHEMA_VERSION',
    file: 'src/jitrl/experience-store.ts',
    reason:
      'Records the schema version of records written before per-execution attribution, so an upgrade can ' +
      'identify them. The store discriminates on the current EXPERIENCE_SCHEMA_VERSION and treats anything ' +
      'else as legacy, so this named predecessor has no reader. It is the documented migration anchor.'
  },
  {
    symbol: 'PREVIOUS_REWARD_CONTRACT_VERSION',
    file: 'src/jitrl/reward-contract.ts',
    reason:
      'The previous reward scale, whose own comment says it is "kept referenced so upgrades stay explicit". ' +
      'Nothing actually references it: the compatibility table below spells the predecessor literal out ' +
      'as a key, so replacing the identifier never happened. That makes the comment aspirational and the ' +
      'constant dead.'
  },
  {
    symbol: 'REWARD_CONTRACT_COMPATIBLE_IDS_PR_B',
    file: 'src/jitrl/reward-contract.ts',
    reason:
      'Compatibility table mapping a reward version to the reward ids it may consume. The eligibility ' +
      'checks compare version strings directly, so the table is never consulted and cannot be driving any ' +
      'decision; it is an audited record of the intended cross-version allowances, not executable policy.'
  },
  {
    symbol: 'RESCORE_REWARD_VERSION_PR_B',
    file: 'src/jitrl/reward-contract.ts',
    reason:
      'Reward id stamped on backfill copies recomputed from preserved original evidence. The backfill path ' +
      'uses the non-PR-B RESCORE_REWARD_VERSION instead, so this sibling id has no reader; it names a ' +
      'version boundary the code currently does not cross.'
  },
  {
    symbol: 'STEP_BUDGET_SIGNAL_SCALE',
    file: 'src/jitrl/step-evaluator.ts',
    reason:
      'Documents the step-efficiency signal range (-1 at or above budget, +1 at one step). The evaluator ' +
      'computes the signal from the budget arithmetic and never reads this scale, so the constant is a ' +
      'written-down invariant rather than a consumed parameter.'
  },
  {
    symbol: 'GRAPH_ENTITY_TOOLS',
    file: 'src/memory-bridge/drivers/graph-entity.driver.ts',
    reason:
      'Tool-name candidates for the graph-entity ecosystem. Auto-discovery scores against DRIVER_FINGERPRINTS ' +
      'in drivers/index.ts, which repeats these tool names verbatim (recallCandidates/commitCandidates/' +
      'pruneCandidates), so this per-driver copy is a dead duplicate and the fingerprint table is the real ' +
      'source.'
  },
  {
    symbol: 'LINGSHU_MDCG_TOOLS',
    file: 'src/memory-bridge/drivers/lingshu-mdcg.driver.ts',
    reason:
      'Tool-name candidates for the 灵枢 mdcg ecosystem, duplicated as the lingshu_mdcg entry of ' +
      'DRIVER_FINGERPRINTS in drivers/index.ts. No reader exists, so the exported constant is a second copy ' +
      'that could drift from the table that actually drives fingerprint scoring.'
  },
  {
    symbol: 'MARKDOWN_NOTE_TOOLS',
    file: 'src/memory-bridge/drivers/markdown-note.driver.ts',
    reason:
      'Tool-name candidates for the markdown-note backend, duplicated as the markdown_note entry of ' +
      'DRIVER_FINGERPRINTS in drivers/index.ts. Like its siblings in this family it has no reader, so it is ' +
      'a dead duplicate rather than a consumed table.'
  },
  {
    symbol: 'TEMPORAL_GRAPH_TOOLS',
    file: 'src/memory-bridge/drivers/temporal.driver.ts',
    reason:
      'Tool-name candidates for the temporal-graph backend, duplicated as the temporal entry of ' +
      'DRIVER_FINGERPRINTS in drivers/index.ts. Nothing reads this per-driver copy; the fingerprint table is ' +
      'the surface auto-discovery scores against.'
  },
  {
    symbol: 'VECTOR_FACT_TOOLS',
    file: 'src/memory-bridge/drivers/vector-fact.driver.ts',
    reason:
      'Tool-name candidates for the vector-fact backend, duplicated as the vector_fact entry of ' +
      'DRIVER_FINGERPRINTS in drivers/index.ts. No reader exists in src/ or tests/, so this constant is a ' +
      'fourth dead duplicate in the same family.'
  },
  {
    symbol: 'sanitizeSegment',
    file: 'src/memory-bridge/governance-polyfill.ts',
    reason:
      'Alias of sanitizeNamespaceSegment whose comment says it is "re-exported for adapter authors". No ' +
      'adapter author exists in this tree: every driver sanitizes through the namespaced function (or the ' +
      'namespace module), so the alias is documented intent with no consumer.'
  },
  {
    symbol: 'createUniversalMemoryBridge',
    file: 'src/memory-bridge/index.ts',
    reason:
      'Readability alias of createMemoryBridge whose comment says it is "kept for readability at the ' +
      'integration site". The integration site imports createMemoryBridge from the barrel instead, and ' +
      'src/index.ts does not publish this alias, so nothing names it.'
  },
  {
    symbol: 'PersistenceDataDirOptions',
    file: 'src/persistence/index.ts',
    reason:
      'Alias of ProfileDataDirOptions for callers that resolve the directory themselves. resolvePersistenceDataDir ' +
      'takes PersistenceRuntimeOptions, so no caller ever names the alias; it survives as a barrel convenience ' +
      'type with no reader, and src/index.ts does not re-export it.'
  },
  {
    symbol: 'PersistedPolicy',
    file: 'src/persistence/index.ts',
    reason:
      'Alias of MetaSearchPolicy for callers that restore a policy explicitly. The restore path is typed on ' +
      'MetaSearchPolicy from the dream-rsi layer, so this barrel alias is unreferenced and cannot be reached ' +
      'from the package root.'
  },
  {
    symbol: 'SurfacePayloadFor',
    file: 'src/types/contracts.ts',
    reason:
      'Generic payload lookup for one surface key. Every consumer indexes SurfacePayloadMap directly or ' +
      'uses SupportedSurfacePayload, so this generic helper is never instantiated; it stays as the ' +
      'documented way to derive a per-key payload type.'
  },
  {
    symbol: 'MemoryScopeKind',
    file: 'src/types/contracts.ts',
    reason:
      'Union of the scope kinds virtual namespace isolation supports. The isolation code carries the ' +
      'literal union inline in its own scope spec, so this exported alias is never named as a type — it is ' +
      'the contract-side statement of the same three scopes.'
  }
]);

const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_USAGE = 2;

function parseArgs(argv) {
  const out = { json: false, root: undefined, allowlist: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      out.json = true;
    } else if (arg === '--root') {
      out.root = argv[i + 1];
      i += 1;
    } else if (arg === '--allowlist') {
      out.allowlist = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: node scripts/eval/check-orphan-exports.mjs [--json] [--root <dir>] [--allowlist <file>]\n'
      );
      process.exit(EXIT_OK);
    } else {
      process.stderr.write('[orphan-exports] unknown argument: ' + arg + '\n');
      process.exit(EXIT_USAGE);
    }
  }
  return out;
}

function loadAllowlist(args) {
  if (args.allowlist === undefined) {
    return DEFAULT_ALLOWLIST;
  }
  const raw = fs.readFileSync(args.allowlist, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('allowlist file must contain a JSON array');
  }
  return parsed;
}

function listTsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) {
    return out;
  }
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function readParsed(fileName) {
  const text = fs.readFileSync(fileName, 'utf8');
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function isExported(node) {
  return (
    Array.isArray(node.modifiers) && node.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/**
 * The module's own exported declarations — every kind, per the header口径.
 * A declaration without a name (`export default`, an `export =`) is skipped:
 * it has no symbol to search for.
 */
function collectExports(fileName, source) {
  const found = [];
  const visit = (node) => {
    if (isExported(node)) {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        found.push({ symbol: node.name.text, kind: 'function' });
      } else if (ts.isClassDeclaration(node) && node.name !== undefined) {
        found.push({ symbol: node.name.text, kind: 'class' });
      } else if (ts.isInterfaceDeclaration(node)) {
        found.push({ symbol: node.name.text, kind: 'interface' });
      } else if (ts.isTypeAliasDeclaration(node)) {
        found.push({ symbol: node.name.text, kind: 'type alias' });
      } else if (ts.isEnumDeclaration(node)) {
        found.push({ symbol: node.name.text, kind: 'enum' });
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            found.push({ symbol: declaration.name.text, kind: 'const' });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.map((entry) => ({ ...entry, file: fileName }));
}

/** Declaration sites that are the symbol ITSELF (never its own reader). */
function isOwnDeclaration(node) {
  const parent = node.parent;
  return (
    parent !== undefined &&
    ((ts.isFunctionDeclaration(parent) && parent.name === node) ||
      (ts.isClassDeclaration(parent) && parent.name === node) ||
      (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
      (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
      (ts.isEnumDeclaration(parent) && parent.name === node) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node))
  );
}

function collectIdentifierSites(fileName, source) {
  const sites = [];
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      sites.push({ file: fileName, name: node.text, isDeclarationName: isOwnDeclaration(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function evaluate(root, allowlist) {
  const sourceFiles = listTsFiles(path.join(root, 'src'));
  const readerFiles = [...sourceFiles, ...listTsFiles(path.join(root, 'tests'))];

  const exportsByFile = new Map();
  for (const file of sourceFiles) {
    exportsByFile.set(file, collectExports(file, readParsed(file)));
  }

  const sitesByName = new Map();
  for (const file of readerFiles) {
    for (const site of collectIdentifierSites(file, readParsed(file))) {
      const bucket = sitesByName.get(site.name);
      if (bucket === undefined) {
        sitesByName.set(site.name, [site]);
      } else {
        bucket.push(site);
      }
    }
  }

  const orphans = [];
  for (const [file, entries] of exportsByFile) {
    for (const entry of entries) {
      const sites = sitesByName.get(entry.symbol) ?? [];
      // A reader is any occurrence that is not a declaration name of this
      // symbol anywhere — including a same-file call, which is a genuine reader.
      const readers = sites.filter((site) => !(site.file === file && site.isDeclarationName));
      if (readers.length === 0) {
        orphans.push({
          symbol: entry.symbol,
          kind: entry.kind,
          file: path.relative(root, file).split(path.sep).join('/')
        });
      }
    }
  }

  const violations = [];
  const matchedAllowlist = new Set();
  for (const orphan of orphans) {
    const allowed = allowlist.find(
      (entry) => entry.symbol === orphan.symbol && entry.file === orphan.file
    );
    if (allowed === undefined) {
      violations.push({
        code: 'orphan-export',
        file: orphan.file,
        symbol: orphan.symbol,
        detail:
          'exported ' + orphan.kind + ' has no reader in src/ or tests/ (dead code or untested surface)'
      });
    } else {
      matchedAllowlist.add(allowed);
    }
  }

  for (const entry of allowlist) {
    if (typeof entry.reason !== 'string' || entry.reason.length < MIN_REASON_LENGTH) {
      violations.push({
        code: 'allowlist-reason-too-short',
        file: entry.file,
        symbol: entry.symbol,
        detail: 'reason must be at least ' + String(MIN_REASON_LENGTH) + ' characters'
      });
    }
    if (!matchedAllowlist.has(entry)) {
      violations.push({
        code: 'allowlist-stale',
        file: entry.file,
        symbol: entry.symbol,
        detail: 'allowlisted symbol is no longer an orphan; drop the entry'
      });
    }
  }

  return {
    ok: violations.length === 0,
    scannedFiles: sourceFiles.length,
    readerFiles: readerFiles.length,
    orphans: orphans.length,
    allowlisted: matchedAllowlist.size,
    violations
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(args.root ?? path.join(here, '..', '..'));
  let allowlist;
  try {
    allowlist = loadAllowlist(args);
  } catch (error) {
    process.stderr.write('[orphan-exports] cannot read allowlist: ' + String(error) + '\n');
    process.exit(EXIT_USAGE);
  }
  let result;
  try {
    result = evaluate(root, allowlist);
  } catch (error) {
    process.stderr.write('[orphan-exports] ' + String(error) + '\n');
    process.exit(EXIT_USAGE);
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (result.ok) {
    process.stdout.write(
      '[orphan-exports] OK: ' +
        String(result.scannedFiles) +
        ' source file(s), ' +
        String(result.orphans) +
        ' orphan(s) all allow-listed (' +
        String(result.allowlisted) +
        ').\n'
    );
  } else {
    process.stderr.write('[orphan-exports] FAIL: ' + String(result.violations.length) + ' violation(s)\n');
    for (const violation of result.violations) {
      process.stderr.write(
        '  ' + violation.code + ' @ ' + violation.file +
          (violation.symbol === undefined ? '' : ' [' + violation.symbol + ']') +
          ' — ' + violation.detail + '\n'
      );
    }
  }
  process.exit(result.ok ? EXIT_OK : EXIT_VIOLATION);
}

main();
