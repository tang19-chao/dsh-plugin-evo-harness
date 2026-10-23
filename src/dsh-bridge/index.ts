/**
 * Public surface of the DeepSeek Harness bridge (multi-step agent probe).
 *
 * `src/index.ts` re-exports this barrel, so a host resolves the executor from the
 * package entry instead of importing an internal path. The executor is a plain
 * {@link BranchExecutor}: it never forks, mounts or cleans up branch resources
 * itself — that stays with the Cordis seam manager.
 */
export * from './agent-loop-executor';
