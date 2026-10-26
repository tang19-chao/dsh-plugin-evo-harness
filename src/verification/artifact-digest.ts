/**
 * C2a (ADR 0003 T3): the HOST-recomputed artifact digest.
 *
 * The digest is the only value that binds a verdict to the thing it judged, so
 * the host must derive it from the artifact bytes itself - never from a caller
 * declared string. The canonical framing is explicit and versioned so a future
 * framing change is a visible contract change, not a silent hash drift.
 */
import { createHash } from 'node:crypto';
import type { ProbeTrajectory } from '../types/contracts';
import { ARTIFACT_DIGEST_PREFIX, type HostArtifact } from './types';

/** Framing tag; bumping it changes every digest (deliberate, greppable). */
export const ARTIFACT_FRAMING_VERSION = 'dsh-c2a-artifact-v1' as const;

/**
 * Extract the artifact the host will verify from a finalized trajectory.
 *
 * Returns `undefined` when there is nothing to verify: a missing deliverable,
 * or an empty content with no produced files. Those cases are the
 * `artifact-missing` rejection (ADR 0003 §4.6 R-a): the host cannot recompute a
 * digest, so no verdict may exist for this trajectory.
 */
export function artifactOf(trajectory: ProbeTrajectory): HostArtifact | undefined {
  const deliverable = trajectory.deliverable;
  if (deliverable === undefined) {
    return undefined;
  }
  const producedFiles = [...(deliverable.producedFiles ?? [])].sort();
  if (deliverable.content.length === 0 && producedFiles.length === 0) {
    return undefined;
  }
  return { content: deliverable.content, producedFiles };
}

/**
 * Canonical bytes the digest is computed over (deterministic framing).
 *
 * `producedFiles` is canonicalised (sorted) here as well as in `artifactOf`, so
 * a caller passing an unsorted list still gets the same digest for the same file
 * SET - one digest per artifact, not one per ordering.
 */
export function artifactBytes(artifact: HostArtifact): Buffer {
  const files = [...artifact.producedFiles].sort();
  const fileCount = files.length;
  const parts: Buffer[] = [
    Buffer.from(ARTIFACT_FRAMING_VERSION + '\n', 'utf8'),
    Buffer.from('content:' + String(Buffer.byteLength(artifact.content, 'utf8')) + '\n', 'utf8'),
    Buffer.from(artifact.content, 'utf8'),
    Buffer.from('\nfiles:' + String(fileCount) + '\n', 'utf8')
  ];
  for (const file of files) {
    parts.push(Buffer.from('file:' + String(Buffer.byteLength(file, 'utf8')) + '\n', 'utf8'));
    parts.push(Buffer.from(file, 'utf8'));
    parts.push(Buffer.from('\n', 'utf8'));
  }
  return Buffer.concat(parts);
}

/** `sha256:<64 lowercase hex>` over the canonical artifact bytes. */
export function artifactDigestOf(artifact: HostArtifact): string {
  return (
    ARTIFACT_DIGEST_PREFIX + createHash('sha256').update(artifactBytes(artifact)).digest('hex')
  );
}
