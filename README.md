# dsh-plugin-evo-harness

A DeepSeek Harness (Cordis) plugin for **test-time self-evolution of the agent harness**.
The model weights stay frozen; what changes is the scaffold around the model - the eight
editable surfaces (**system prompt, guardrails, memory, tool guidance, skills, scripts,
subagents, plugins**) mounted as reversible Cordis capability seams (`ctx.fork()` +
idempotent disposers). Candidates are proposed along two asymmetric tracks (memory-guided
*domain* and memory-free *invariant*), executed in isolated branches, contrasted
**anonymously on behaviour** because no ground-truth verifier exists, composed into a winning
scaffold `H*`, and distilled into governed `CanonicalLesson` records. Dream-RSI provides the
online meta-controller (`plan_grid` plus a three-way exploit / explore-domain / explore-invariant
/ recover portfolio) and a zero-execution offline dreamer that replays historical discovery
trees to improve the search policy without running a model or a sandbox. The Universal MCP
memory bridge speaks to any MCP memory backend (graph, vector, temporal, markdown notes, or
the 灵枢 `md_cg` whitebox) and adds a client-side governance polyfill: CCG six-element
validation, virtual namespace isolation and a negative-evidence firewall. The complete design,
including the module-by-module responsibilities and the end-to-end sequence, is in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Table of contents

- [Requirements](#requirements)
- [Install and verify](#install-and-verify)
- [Quick start configuration](#quick-start-configuration)
- [Configuration reference](#configuration-reference)
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Limitations and status](#limitations-and-status)
- [Design document](#design-document)

## Requirements

| Requirement | Value | Source |
| :--- | :--- | :--- |
| Node.js | `>=20.19.0` | `engines.node` in [package.json](package.json) |
| pnpm | `11.7.0` | `packageManager` (`pnpm@11.7.0`) in [package.json](package.json) |
| Runtime dependencies | none | the package declares no `dependencies`; only `devDependencies` (TypeScript, Vitest, `@types/node`) |
| Cordis host | supplied by the host | the package never imports `cordis`; all seams are structural ([src/index.ts](src/index.ts)) |
| MCP memory server | supplied by the host | the bridge consumes an injectable MCP client, never a concrete server ([src/memory-bridge/spi.ts](src/memory-bridge/spi.ts)) |

Everything else is injected at mount time: the LLM boundary (`IModelAdapter`), the mounted
MCP clients, the host task runner used inside a probe branch (`BranchExecutor`), and the
Cordis capability adapter itself. When a run actually needs those and they were not provided,
the plugin fails loudly instead of pretending - `no model adapter was injected` and
`no branch executor was injected; the host must supply options.runBranch` are returned as
deterministic failures.

## Install and verify

### Install into a DeepSeek Harness profile (the normal path)

The package ships a `dsh.bundle.patch` layer ([cordis.patch.yml](cordis.patch.yml)) and a
Node-loadable ESM entry (`lib/index.js`), so `dsh plugin add` installs and mounts it in one
step. Desktop's profile is reserved for the Electron application, but its own CLI manages it:

```bash
# from a checkout of this repository (absolute path required)
dsh plugin --profile desktop add "link:<absolute-path-to-this-repo>"
```

`dsh plugin` forwards to pnpm inside the profile, then reconciles every new dependency that
declares `dsh.bundle` into `dsh.profile.bundles`. The plugin is live after the next launch.
Remove it with `dsh plugin --profile desktop remove dsh-plugin-evo-harness`.

Confirm the composed tree picked the entry up:

```bash
dsh --profile <name> --dump-config   # look for `id: evo-harness`
```

### Build and verify from source

Clone the repository and install the pinned toolchain:

```bash
git clone <repository-url> dsh-plugin-evo-harness
cd dsh-plugin-evo-harness
corepack enable          # optional: activates the pinned pnpm 11.7.0
pnpm install --frozen-lockfile
pnpm run build           # bundles src/index.ts to lib/index.js (esbuild)
```

`lib/` is a build artifact and is git-ignored: run `pnpm run build` before installing the
package anywhere, since the loader resolves `main`/`exports` to `lib/index.js`.

The scripts below are quoted verbatim from `package.json` `scripts`; nothing else is needed to
build the project, because TypeScript is only ever type-checked (`noEmit`) and Vitest
transpiles on the fly.

| Command | Underlying script | What it does |
| :--- | :--- | :--- |
| `pnpm run typecheck` | `tsc --noEmit` | Full static typecheck of `src/**` and `tests/**` |
| `pnpm run test` | `vitest run` | Every unit and end-to-end suite |
| `pnpm run test:unit` | `vitest run tests/unit` | Unit suites only |
| `pnpm run test:e2e` | `vitest run tests/e2e` | End-to-end suites only |
| `pnpm run check:docs` | `node scripts/verify-readme-counts.mjs` | Mechanically validates README test counts against test results and repo hygiene |
| `pnpm run verify` | `pnpm run typecheck && pnpm run test` | The full gate: typecheck, then every suite |

A green checkout currently reports `74` test files and `1450` passing tests for `pnpm run test`
(see [Testing](#testing) for the breakdown). This package is `private` and is not published to
any registry, so there are no publication steps.

## Quick start configuration

The host passes the plugin section of `cordis.yml` to the plugin, where it is validated by
`parseEvoHarnessConfig()` ([src/config.ts](src/config.ts)). The example below mounts an MCP memory
server next to the plugin; every value shown is the built-in default, and every key is one the
parser accepts.

```yaml
plugins:
  # 1. Mount any standard MCP memory client (Mem0, official Knowledge Graph,
  #    Zep/Graphiti, Basic-Memory, dsh-memory/灵枢, ...). The bridge
  #    auto-discovers the driver from tools/list.
  "@deepseek-harness/plugin-mcp":
    servers:
      mem0:
        command: "npx"
        args: ["-y", "@mem0/mcp-server"]
        env:
          MEM0_API_KEY: "${MEM0_API_KEY}"

  # 2. Mount this plugin. Everything below is a default value.
  "dsh-plugin-evo-harness":
    schemaVersion: 1                 # default
    triggerMode: "auto_fallback"     # default: 'auto_fallback' | 'always' | 'slash_command'

    # default: all eight surfaces, in mounting order
    enabledSurfaces:
      - system_prompt
      - guardrails
      - memory
      - tool_guidance
      - skills
      - scripts
      - subagents
      - plugins

    memoryBridge:
      mcpServerTarget: "auto"        # default: sniff every mounted MCP server ('auto' or a server id)
      enableGovernancePolyfill: true # default: CCG gate + namespace isolation + negative firewall
      customMapping:                 # default: enabled=false, names only matter when you enable it
        enabled: false
        recallToolName: "my_custom_search"
        commitToolName: "my_custom_upsert"

    dreamRsi:
      maxOnlineRolloutBudget: 8          # default: hard upper bound on candidate rollouts
      enableAsymmetricGuidance: true     # default: invariant branches stay guidance-free
      offlineDreamTriggerEveryNTasks: 10 # default: completed tasks between offline dream replays
      candidatePoliciesCount: 6          # default: candidate meta-policies per dream

    # Second-level settings page. Every leaf is .volatile(), so the DSH settings
    # UI can write it and the loader commits it without a restart.
    modelRoute:
      provider: "qodercn"    # default: the verified DSH default route
      model: "dfmodel"
      reasoningEffort: "max" # high | max | low
```

The mountable collaborators are injected in code, not in `cordis.yml`. The plugin exports the
standard Cordis shape (a default `{ name, apply }` plus the named `apply`), so the host calls it
for you; the snippet below shows the four optional injections that turn a dry run into a real
one ([src/index.ts](src/index.ts), `EvoHarnessPluginOptions`):

```ts
import { apply } from 'dsh-plugin-evo-harness'; // default export is { name, inject, Config, apply }

const plugin = apply(ctx, {
  config: myConfigSection, // the "dsh-plugin-evo-harness" section above (or ctx.config)
  model,                   // IModelAdapter used by propose / compose / reflect
  clients,                 // mounted MCP clients; omit and pass listClients for late mounts
  runBranch                // BranchExecutor: the host task runner executed inside a branch
});

const result = await plugin.run({
  sessionId,
  task: plugin.makeTask({ prompt: 'migrate the schema and report JSON' }),
  trigger: 'always'
});

console.log(result.outcome, result.probesRun, result.lessonsCommitted);
await plugin.dispose();
```

The plugin registers the `/evo` slash command through `ctx.commands.register`, subscribes the
**verified DSH events** below, and exposes the mounted handle as the `evoHarness` service. If the
host context exposes no command registrar or event subscriber, the equivalent entrypoints
`plugin.runFromCommand(args, context)` and `plugin.handleFallbackEvent(payload)` are the supported
fallbacks, and the reason is recorded in `plugin.diagnostics`.

### Trigger contract (verified against the shipped runtime)

The event names and payload shapes below were read out of `resources/app.asar`, not assumed.

| `TurnEndReason.kind` | Meaning for this plugin |
| :--- | :--- |
| `completed` | normal end; triggers **only** under `triggerMode: always` |
| `error` | failure (`reason.error` carries `{message, code}`) |
| `aborted` / `blocked` / `max-tokens` / `interrupted` / `forked` | observed and ignored |

| DSH event | Payload | Used for |
| :--- | :--- | :--- |
| `session/event` | `(session, event)` | `event.type: 'tool/result'` with `event.data.message.isError`; `event.type: 'turn/end'` with `event.data.reason.kind` |
| `agent/error` | `{agent, turn, step, error}` | always a failure |
| `agent/status` | `{status: 'idle' \| 'running'}` | `idle` → optional offline dream through `agent.runMaintenance` |

`agent/status` carries **only** `{status}` (the loop emits `{ status }`); the agent comes from the
fused dispatch payload or `ctx.agents.list()`. `agent.runMaintenance(job)` throws unless the agent
is idle, so every call is try/catch-wrapped and a lost race is recorded instead of surfaced.

The three modes are genuinely distinct:

| `triggerMode` | Listens for |
| :--- | :--- |
| `slash_command` | nothing — `/evo` is the only entry point |
| `auto_fallback` | failure events only (`tool/result` error, `turn/end` error, `agent/error`) |
| `always` | failure events **plus** `turn/end` `completed` |

> **Migration note.** Earlier versions documented `task:failed` and `tool:error` as the
> `auto_fallback` events. Those names do not exist anywhere in DSH, so the hook could never fire.
> They are no longer defaults; a non-DSH transport that emits them can opt in through
> `autoFallbackEvents`, and the plugin then warns that the names are unverified.

DSH dispatches `session/event` as a contained fire-and-forget emit, so a listener cannot return a
run's result. `plugin.settle()` is the deterministic join point: it awaits every trigger-initiated
run and returns the results. Teardown awaits it too, so a run started by the last event is not
aborted mid-flight.

## Configuration reference

Defaults are the frozen values in [src/config.ts](src/config.ts) `DEFAULT_EVO_HARNESS_CONFIG`; the
section below matches ARCHITECTURE.md section 6.2. Validation is strict: unknown keys,
wrong types, out-of-range numbers, duplicate surfaces and unnormalized surrogate weights are
rejected with a `ConfigValidationError` carrying every issue (`unknown_key`, `invalid_type`,
`out_of_range`, `invalid_enum`, `duplicate_value`, `weights_not_normalized`, ...), so a typo in
`cordis.yml` fails fast instead of silently disabling a safety feature.

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `schemaVersion` | `1` | Config schema version; a breaking change needs a new contract round |
| `enabled` | `true` | Mount the plugin |
| `triggerMode` | `"auto_fallback"` | `auto_fallback` (failure events only), `always` (failures + `turn/end completed`), or `slash_command` (`/evo` only) |
| `modelRoute.provider` | `"qodercn"` | Provider route on the second-level settings page (volatile) |
| `modelRoute.model` | `"dfmodel"` | Model id on the second-level settings page (volatile) |
| `modelRoute.reasoningEffort` | `"max"` | `high` \| `max` \| `low` (volatile) |
| `enabledSurfaces` | all eight | Surfaces eligible for patching, in mounting order |
| `probe.maxConcurrentProbes` | `4` | Concurrent isolated probes (1-16) |
| `probe.probeTimeoutMs` | `120000` | Per-probe timeout in ms (1000-600000) |
| `memoryBridge.mcpServerTarget` | `"auto"` | `auto` sniffs every mounted MCP server, or a concrete server id such as `mem0` |
| `memoryBridge.driverHint` | `"auto"` | Force a driver: `graph_entity`, `vector_fact`, `temporal_graph`, `markdown_note`, `lingshu_mdcg`, `custom_mapped` |
| `memoryBridge.enableGovernancePolyfill` | `true` | Client-side CCG validation, virtual namespace isolation, negative firewall |
| `memoryBridge.customMapping.enabled` | `false` | Use explicit tool-name mapping for an unknown backend |
| `memoryBridge.customMapping.recallToolName` | `"my_custom_search"` | Recall tool name used when `customMapping.enabled` is true |
| `memoryBridge.customMapping.commitToolName` | `"my_custom_upsert"` | Commit tool name used when `customMapping.enabled` is true |
| `memoryBridge.requestTimeoutMs` | `10000` | MCP request timeout in ms |
| `memoryBridge.recallLimit` | `6` | Maximum lessons recalled per task |
| `memoryBridge.namespacePrefix` | `"harness2"` | Prefix for the deterministic scope namespaces |
| `memoryBridge.requireEvidence` | `true` | Reject lessons without probe contrast evidence |
| `memoryBridge.enableNegativeFirewall` | `true` | Keep negative lessons out of the recommendation channel |
| `memoryBridge.promoteOnComposeSuccess` | `true` | Promote a winning lesson out of branch scope after composition |
| `dreamRsi.maxOnlineRolloutBudget` | `8` | Hard upper bound on candidate rollouts per task; `plan_grid` may only reduce it |
| `dreamRsi.enableAsymmetricGuidance` | `true` | Domain slots may read memory; invariant slots are guidance-free |
| `dreamRsi.offlineDreamTriggerEveryNTasks` | `10` | Completed tasks between offline dream replays |
| `dreamRsi.candidatePoliciesCount` | `6` | Candidate meta-policies generated per dream |
| `dreamRsi.rhoPreferences` | `[0, 0.25, 0.5, 0.75, 1]` | Strictly ascending budget preferences for Pareto replay |
| `dreamRsi.surrogateWeights` | `{selection 0.4, adoption 0.3, efficiency 0.2, toolErrorPenalty 0.1}` | Surrogate reward weights; must sum to 1 |
| `dreamRsi.maxTreePoolSize` | `200` | Historical discovery trees kept for replay |
| `dreamRsi.maxWidth` | `4` | Hard upper bound on tree width for `plan_grid` |
| `dreamRsi.maxDepth` | `3` | Hard upper bound on tree depth for `plan_grid` |
| `dreamRsi.maxRecoverySlots` | `1` | Recovery slots allowed per batch (at most one) |
| `dreamRsi.earlyStopThreshold` | `0.8` | Early-stop threshold used by the active policy |
| `dreamRsi.minMemoryConfidenceForSkip` | `0.75` | Memory confidence at which probing may be skipped |
| `logging.level` | `"info"` | `debug` / `info` / `warn` / `error` / `silent` |
| `logging.includeTrajectorySummaries` | `false` | Include trajectory summaries in log output |

Two optional keys have no default and may be omitted: `memoryBridge.customMapping.pruneToolName` and
the free-form `metadata` bags accepted by the internal APIs.

## How it works

One evolution run walks the lifecycle implemented in [src/orchestrator.ts](src/orchestrator.ts):

1. **initialize** - bind the memory backend through MCP auto-discovery.
2. **recall** - governed recall for the incoming task; positive lessons are recommendations,
   negative lessons are anti-pattern warnings, and clauses that match the task context are
   withheld by the firewall.
3. **plan_grid** - the active policy `pi_t` derives width, depth, budget and a stop condition from
   task complexity and memory confidence (high confidence can collapse to zero probes).
4. **reference_probe** - a baseline run without scaffold edits, used as the contrast anchor.
5. **select_batch** - a three-way portfolio: exploit (deepen the best node), explore-domain
   (memory-guided) and explore-invariant (guidance-free, no external memory), plus at most one
   recovery slot driven by the failure taxonomy.
6. **propose** - the Harness2 dual-track proposer renders the prompt for the slot and validates
   the model's JSON into an `EightSurfacePatch`.
7. **probe** - the patch is mounted in an isolated Cordis branch and executed by the host runner;
   the trajectory collector records event-sourced steps, tool errors and failure signals.
8. **classify** - the four-way failure taxonomy (`hard_unrecoverable`, `repairable_implementation`,
   `weak_underexplored`, `repeatedly_unpromising`) picks the next action.
9. **score** - the verifier-free surrogate score `s_v in [0, 1]` from selection, adoption ratio,
   step efficiency and tool-error rate.
10. **compose** - the anonymous composer contrasts candidates on behaviour only, picks the
    evidence-supported winner and merges `H*`.
11. **reflect** - the reflector emits complete `CanonicalLesson` objects (all six CCG elements,
    including restraint clauses) for successful *and* failed candidates.
12. **commit** - lessons pass the client-side governance gate before they reach the MCP backend.
13. **apply_patch** - the winning scaffold is mounted permanently through an idempotent disposer.
14. **offline_dream** - every N completed tasks, historical trees are replayed with zero model
    and sandbox calls, and the meta-policy is hot-swapped only on strict improvement.
15. **finalize** - an `EvoHarnessRunResult` summary is returned to the host.

The code is split into four module trees plus the integrator-owned entrypoint:

| Module | Responsibility |
| :--- | :--- |
| [src/cordis-seams/](src/cordis-seams/index.ts) | Branch forking, the eight reversible surface mounters, the disposable registry and the event-sourced trajectory collector |
| [src/harness2/](src/harness2/index.ts) | Dual-track proposer (domain vs invariant), anonymous behavioural composer, evidence-chain reflector |
| [src/dream-rsi/](src/dream-rsi/index.ts) | Discovery tree with causal-prefix views, failure taxonomy, active policy (`plan_grid` + batching), surrogate scorer, offline dreamer |
| [src/memory-bridge/](src/memory-bridge/index.ts) | Unified memory SPI, MCP auto-discovery, six drivers, governance polyfill, virtual namespaces, lesson codec |

The cross-module contracts are frozen in [src/types/contracts.ts](src/types/contracts.ts); no
module imports a host, network or sandbox package, which is why every suite runs without a live
LLM.

## Project layout

```text
dsh-plugin-evo-harness/
├── ARCHITECTURE.md          # the design document (sections 1-7)
├── CHANGELOG.md             # version history and hardening notes
├── LICENSE                  # Apache-2.0 license (pending author confirmation)
├── package.json             # engines, packageManager, scripts, devDependencies
├── tsconfig.json            # strict ES2022 / Bundler typecheck, noEmit
├── scripts/
│   └── verify-readme-counts.mjs # mechanical verification of README metrics in CI
├── src/
│   ├── index.ts             # Cordis entrypoint: apply(ctx), /evo command, auto_fallback hook, evoHarness service
│   ├── config.ts            # schema, frozen defaults, deterministic validation
│   ├── orchestrator.ts      # the 15-stage lifecycle
│   ├── types/contracts.ts   # frozen contracts shared by all modules
│   ├── cordis-seams/        # eight-surface mounters, context forker, seam manager, trajectory collector
│   ├── harness2/            # proposer, composer, reflector, shared helpers
│   ├── dream-rsi/           # discovery tree, failure taxonomy, active policy, surrogate scorer, offline dreamer
│   └── memory-bridge/       # SPI, auto-discovery, governance polyfill, namespace isolation, drivers/
└── tests/
    ├── unit/
    │   ├── cordis-seams/    # mounts, rollback, branch isolation, trajectory metrics
    │   ├── harness2/        # asymmetric prompts, anonymous composition, lesson extraction
    │   ├── dream-rsi/       # tree/prefix views, taxonomy, batching, scoring, replay
    │   └── memory-bridge/   # auto-discovery, governance gate, isolation, firewall, drivers
    └── e2e/                 # plugin entrypoint, full lifecycle, memory backends, offline dream, governance
```

## Testing

Every adapter is injectable, so the suites run offline: no network, no LLM, no sandbox. The
unit suites cover the module contracts (eight-surface mounting and rollback, branch isolation
and trajectory metrics, asymmetric proposal prompts, anonymous composition and adoption ratios,
canonical lesson extraction, discovery-tree causal prefixes, failure taxonomy, policy planning
and batching, surrogate scoring, governance gate, negative firewall and the six memory drivers).
The end-to-end suites drive the mounted plugin through `apply(ctx, config)`: the plugin entrypoint
(`/evo` command, `auto_fallback` events, `evoHarness` service, host-adapter disposal), the full
lifecycle, backend-specific memory behaviour, the governance gate, post-compose evidence and
cross-session promotion, and the offline dream trigger and model wiring.

| Command | Scope | Suites at the time of writing |
| :--- | :--- | :--- |
| `pnpm run test:unit` | `tests/unit` | 63 files, 1303 tests |
| `pnpm run test:e2e` | `tests/e2e` | 11 files, 147 tests |
| `pnpm run test` | everything | 74 files, 1450 tests |
| `pnpm run verify` | typecheck + everything | the gate to run before a change lands |

Individual files can be run the usual Vitest way, for example
`pnpm exec vitest run tests/unit/harness2`.

Because `check:docs` compares the counts above against the live suite, it must be re-run as the
release gate whenever tests are added, removed or renamed.

## Limitations and status

Stated plainly, because they matter when you evaluate this plugin:

- **Host adapter capabilities and real Hook constraints.** `apply(ctx, ...)` discovers Cordis capabilities structurally
  (`ctx.prompt`, `ctx.permissions`, `ctx.tools`, `ctx.skills`, `ctx.sandbox`, `ctx.subagents`, `ctx.middleware`, `ctx.evoMemory`,
  `ctx.fork`) and real DSH hook events; `plugin.hostAdapterSource` reports `'injected'`, `'dsh-hooks'`, `'context'` or
  `'in-memory'`, and the fallback is recorded in `plugin.diagnostics`.
  When real DSH hook events are available (`hostAdapterSource='dsh-hooks'`), the adapter mounts listeners on
  `system-prompt/assemble`, `tools/pre-execute`, `tools/post-execute`, and `agent/pre-step` with branch/session scope isolation.
  However, this real Hook adapter enforces only a **deterministic subset**:
  - It does **not** execute or evaluate generated middleware code (middleware execution belongs to a host-managed sandbox).
  - On `tools/pre-execute`, it deterministically enforces explicit deny rules (`toolPreconditions` starting with `deny`, `forbiddenActions` matching `tool:<name>` or `deny:<name>`, and host-supplied `options.denyTools`).
  - All non-deny natural-language rules and permissive constraints are treated as **advisory** observations rather than hard security boundaries.
  - **Identity is proven, not assumed (D1 strict default).** A dispatch whose
    identity cannot be proven — an anonymous `{name:'bash'}` with no
    branchId/sessionId/namespace, or an identity the ScopeRegistry resolves to
    `unknown` — receives **no advisor advice, triggers no extra Jit ask, and
    writes no learnable experience record**. Ordinary tool execution still
    passes through untouched: the adapter returns the host's own decision and
    never auto-denies or auto-asks for an unknown identity. Unknown events are
    only counted (`scope_unknown_skipped`, payload free — no tool arguments or
    bodies are stored). A session only re-enters the advice/learning tracks
    after the host completes a trusted scope registration with the
    ScopeRegistry; there is no `allowAnonymous` switch
    ([docs/adr/0001](docs/adr/0001-p61-security-contract-and-boundary-rulings.md)).
  When no seam or hook is discoverable the plugin mounts an in-process in-memory host adapter so the lifecycle
  still runs deterministically; that in-memory host is **not** a sandbox, and the repository's own tests never talk to a real Cordis host or a real MCP server.
- **Branch isolation is delegated to the host.** `runInIsolatedBranch` disposes everything it
  mounted on success, failure, timeout and abort, and the memory side gets a deterministic
  branch namespace, but real filesystem/process isolation only exists if the injected host
  honours the `branchId`/`namespace` it is handed (`options.host` / `ctx.fork`).
- **Real runs need injections.** Without an `IModelAdapter`, propose/compose/reflect fail loudly;
  without a `BranchExecutor`, every probe returns a deterministic failure instead of touching a
  sandbox. Neither is bundled.
- **Memory capability is bounded by the backend.** The governance polyfill compensates for
  backends without CCG validation, metadata filtering or branch isolation (falling back to
  prefix-scoped namespaces, ARCHITECTURE.md section 4.3), but it cannot add capabilities a
  server does not expose.
- **Planning is a heuristic, not a guarantee.** `plan_grid`, the three-way batch portfolio and the
  surrogate score are documented heuristics; the offline dreamer is the only component with a
  monotonic non-regression guarantee (a candidate policy must strictly beat `pi^0`).
- **Packaging status.** The package is `private`, version `0.1.0`, and is not published to a
  registry. CI runs `tsc --noEmit`, the full Vitest suite, and mechanical docs hygiene verification on push and pull requests to
  `main` (`.github/workflows/ci.yml`); no status badge is shown. The package is licensed under the
  [Apache-2.0 License](LICENSE) (with copyright attribution pending author confirmation). See [CHANGELOG.md](CHANGELOG.md) for version history.

## Design document

[ARCHITECTURE.md](ARCHITECTURE.md) is the normative design: section 3 maps the eight surfaces
onto Cordis seams, section 4 defines the Canonical Lesson Envelope and the governance
polyfill, section 5 covers the online/offline Dream-RSI loop, section 6 the directory layout,
the interfaces and the example `cordis.yml`, and section 7 the end-to-end sequence.
`src/types/contracts.ts` is the frozen contract surface shared by the implementation modules.

