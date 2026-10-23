/**
 * Shared fixtures for the persistence unit/e2e suites.
 *
 * Temp directories live under <repo>/work/persistence-tmp (gitignored) so the
 * suites work under a workspace-write sandbox, and every suite removes the
 * directories it created.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { createDefaultPolicy } from '../../../src/dream-rsi/active-policy';
import { createDiscoveryTree } from '../../../src/dream-rsi/discovery-tree';
import type {
  DiscoveryTreeSnapshot,
  MetaSearchPolicy,
  PatchOrigin,
  PatchPurpose
} from '../../../src/types/contracts';

/** Root for per-test temp directories; override with EVO_HARNESS_TEST_TMP. */
export const TEST_TMP_ROOT =
  process.env.EVO_HARNESS_TEST_TMP ?? path.join(process.cwd(), 'work', 'persistence-tmp');

/** Create an empty temp directory with the given label prefix. */
export async function makeTempDir(label: string): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true });
  return mkdtemp(path.join(TEST_TMP_ROOT, label + '-'));
}

/** Remove a temp directory (and everything under it) if it exists. */
export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Options for sampleTree(). */
export interface SampleTreeOptions {
  readonly id?: string;
  readonly sessionId?: string;
  readonly taskId?: string;
  /** Number of linear child nodes under the root; defaults to 2. */
  readonly childCount?: number;
}

/**
 * Build a deterministic completed tree snapshot with a root plus a linear child
 * chain, each child probing successfully with a rising score.
 */
export function sampleTree(options: SampleTreeOptions = {}): DiscoveryTreeSnapshot {
  const id = options.id ?? 'tree-1';
  let tick = 1_700_000_000_000;
  const clock = (): number => {
    tick += 1;
    return tick;
  };
  let sequence = 0;
  const tree = createDiscoveryTree({
    id,
    sessionId: options.sessionId ?? 'session-1',
    taskId: options.taskId ?? 'task-1',
    rootPatchId: 'patch-root-' + id,
    clock,
    idFactory: (): string => {
      sequence += 1;
      return id + '-n' + String(sequence);
    }
  });
  const childCount = options.childCount ?? 2;
  let parentId = tree.rootId;
  for (let index = 0; index < childCount; index += 1) {
    const origin: PatchOrigin = index % 2 === 0 ? 'domain' : 'invariant';
    const purpose: PatchPurpose = index === 0 ? 'explore' : 'deepen';
    const node = tree.addNode({
      parentId,
      branchId: id + ':b' + String(index),
      patchId: id + ':patch' + String(index),
      patchOrigin: origin,
      purpose,
      guidance: index % 2 === 0 ? 'memory' : 'guidance_free',
      status: 'succeeded',
      score: 0.5 + 0.1 * index,
      createdAt: clock()
    });
    parentId = node.id;
  }
  tree.setCompleted(true);
  return tree.snapshot();
}

/** Build a valid MetaSearchPolicy derived from the frozen defaults. */
export function samplePolicy(
  id = 'pi-1',
  version = 1,
  overrides: Partial<MetaSearchPolicy> = {}
): MetaSearchPolicy {
  const base = createDefaultPolicy({ id, version }, (): number => 1_700_000_000_000);
  return { ...base, ...overrides };
}