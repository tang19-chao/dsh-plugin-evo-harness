# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-21

### Added
- **Licensing & Repository Hygiene**:
  - Added Apache-2.0 `LICENSE` with explicit pending author / maintainer confirmation notice.
  - Added `CHANGELOG.md` documenting architecture, features, and hardening waves.
  - Added `scripts/verify-readme-counts.mjs` for mechanical verification of README test metrics against Vitest run reports.
  - Added CI workflow verification step in `.github/workflows/ci.yml` to automatically assert test count consistency and documentation hygiene.
- **Reversible Cordis Capability Seams** (`src/cordis-seams/`):
  - Eight mounted surfaces: `system_prompt`, `guardrails`, `memory`, `tool_guidance`, `skills`, `scripts`, `subagents`, and `plugins`.
  - Reversible mounting via Cordis `ctx.fork()` and idempotent disposers.
  - Event-sourced `TrajectoryCollector` recording execution steps, tool interactions, errors, and failure indicators.
- **Dual-Track Proposer, Anonymous Composer & CCG Reflector** (`src/harness2/`):
  - Dual-track proposal mechanism: memory-guided *domain* track and memory-free *invariant* track.
  - Verifier-free anonymous behavioural composer (`compose`) contrasting candidates on trajectory behaviour and merging winning ancestor lineages into $H^*$.
  - Canonical CCG lesson reflector generating structured 6-element lessons with restraint clauses for both positive and negative findings.
- **Dream-RSI Online Controller & Offline Dreamer** (`src/dream-rsi/`):
  - Discovery tree with causal-prefix views and monotonic non-regression guarantees.
  - Four-way failure taxonomy (`hard_unrecoverable`, `repairable_implementation`, `weak_underexplored`, `repeatedly_unpromising`).
  - Active policy (`plan_grid`) with 3-way portfolio: exploit, explore-domain, explore-invariant, and recovery slot allocation.
  - Surrogate scoring function based on candidate selection, adoption ratio, step efficiency, and tool error penalties.
  - Zero-execution offline dreamer for historical discovery tree replay and Pareto meta-policy optimization.
- **Universal MCP Memory Bridge** (`src/memory-bridge/`):
  - Unified memory SPI and automatic MCP driver discovery.
  - Built-in drivers: `graph_entity`, `vector_fact`, `temporal_graph`, `markdown_note`, `lingshu_mdcg`, and `custom_mapped`.
  - Client-side governance polyfill: CCG 6-element validation, virtual namespace isolation, and negative-evidence firewall.
- **Real DeepSeek Harness Hook Adapter** (`src/cordis-seams/dsh-hook-host-adapter.ts`):
  - Four real waterfall hooks — `system-prompt/assemble`, `tools/pre-execute`, `tools/post-execute`, `agent/pre-step` — verified against the installed harness packages rather than assumed.
  - Branch-scoped dispatch: a mount applies only to its own `branchId`, so sibling probe branches sharing one session cannot leak patches into each other.
  - Zero-side-effect construction; listeners install on first use or explicit `install()` and are fully removed by `dispose()`.
  - `plugin.hostAdapterSource` now reports `'dsh-hooks'`, chosen ahead of the structural seams.
- **Multi-Step Agent Probe Executor** (`src/dsh-bridge/`):
  - Real `model → tool → result` loop behind the existing `BranchExecutor` contract, bounded by `maxStepsPerProbe`, the caller's `AbortSignal` and an optional wall-clock budget.
  - Abort and timeout are distinguished (`aborted` vs `timeout`) instead of being collapsed into one status.
  - Degrades to a single model call when no planner or tool runtime is injected, and reports the mode it actually used.
- **Durable TreePool, Policy and Dream Counter** (`src/persistence/`):
  - Profile-scoped data directory with atomic (tmp + fsync + rename) snapshots and JSONL event logs.
  - Restart recovery for the discovery tree pool, the evolved policy `pi_t` and the `shouldDream` counter.
  - Damaged or partially written files are quarantined as `.corrupt` and reported in diagnostics rather than aborting start-up.
  - Wired into the plugin in Phase 0 integration: injecting `options.persistence` restores the pool, resumes `pi_t`, and makes the dream cadence continuous across restarts.

### Fixed & Hardened (Phase 0 Foundation)
- **Post-Compose Re-Score & Pointer Cleanup**: Orchestrator resets initial best score to `-1` and clears stale candidate references so losing candidates cannot retain the exploitation pointer via phantom selection bonuses.
- **Config Enforcement**: Honored `config.enabled = false` (bypasses evolution run with recorded diagnostic) and `triggerMode = 'slash_command'` (suppresses auto-fallback event listeners while preserving `/evo`).
- **MCP Call Deadline Enforcement**: Guaranteed hard deadline cancellation and unhandled rejection protection in `callToolWithTimeout` even when external clients ignore `AbortSignal`.
- **Offline Dreamer Early-Stop Guard**: Prevented phantom recovery probe charging after early-stop thresholds are reached during discovery tree replay.
- **Candidate Tie-Breaking**: Excluded scoreless root node during best-node scans to let real succeeded candidates win creation-order tie-breaks.
- **Multi-Round Lineage Propagation**: Propagated parent candidate patches (`parentPatch`) to round $\ge 2$ proposals, enabling exploit and recovery slots to observe actual modifications.
- **Failure Taxonomy Precedence & Preservation**: Maintained repairable failure visibility across rounds and prioritized terminal diagnoses without masking.
- **Permanent Scaffold Lifecycle**: Added idempotent disposal of previous run permanent patches before mounting newly composed winning scaffolds.
- **Ancestor Lineage Merge**: Merged full ancestor patch lineages in topological ancestry order during composition.
- **Concurrent Probes with Deterministic Commit**: A wave admits slots sequentially, probes them concurrently up to `config.probe.maxConcurrentProbes`, then commits classify/score/tree writes in `slotIndex` order. A probe rejection waits for every started probe to settle, so budget accounting stays a serial prefix and every branch resource is released.
- **Phase 0 Integration Wiring**: `src/index.ts` now exports the persistence and agent-bridge layers and actually consumes them — `options.persistence` supplies the TreePool, the resumed policy and the durable task counter; `options.agentLoop` supplies the executor when no `runBranch` is injected. Previously these modules were complete and tested but unreachable from the package entry, so the dream cadence silently reset on every restart.
- **Repository Hygiene**: One-off `asar-*.cjs` extraction scripts and the extracted `dsh-probe/`, `bridge-verify/` and `f1-repro/` working copies are now git-ignored instead of sitting untracked at the repository root.
