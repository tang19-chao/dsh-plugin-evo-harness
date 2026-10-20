/**
 * Deterministic virtual-namespace derivation (ARCHITECTURE.md 4.3 item 2).
 *
 * Callers never invent namespace strings: the bridge derives them from the
 * configured prefix plus the frozen MemoryScope fields. The same scope always
 * produces the same namespace, which is what makes branch isolation auditable.
 */

import type { MemoryScope } from '../types/contracts';

/** Separator used between scope segments. */
export const NAMESPACE_SEPARATOR = ':';

/** Prefix of the inline scope tag injected into namespace-blind backends. */
export const SCOPE_TAG_PREFIX = '[SCOPE:';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * Make one scope segment safe for a namespace string. Unsafe segments keep a
 * deterministic djb2 fingerprint so two distinct ids (for example
 * 's/1' and 's:1') can never collapse onto the same namespace.
 */
export function sanitizeNamespaceSegment(value: string): string {
  const raw = typeof value === 'string' ? value : '';
  if (SAFE_SEGMENT.test(raw)) {
    return raw;
  }
  return 'x' + djb2Hex(raw) + '_' + raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
}

/** Treat empty strings as absent namespace information. */
export function emptyToUndefined(value: string | undefined | null): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Stable non-cryptographic hash used only for namespace disambiguation. */
export function djb2Hex(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}

/**
 * Namespace for a frozen scope:
 *   global          -> '<prefix>:global'
 *   session         -> '<prefix>:session:<sessionId>'
 *   branch          -> '<prefix>:branch:<sessionId>:<branchId>'
 * The branch form is the deterministic equivalent of the ARCHITECTURE.md
 * probe_<sessionId>_<branchId> scratch namespace.
 */
export function deriveNamespace(scope: MemoryScope, namespacePrefix: string): string {
  const prefix = sanitizeNamespaceSegment(namespacePrefix);
  if (scope.kind === 'global') {
    return prefix + NAMESPACE_SEPARATOR + 'global';
  }
  if (scope.kind === 'session') {
    return prefix + NAMESPACE_SEPARATOR + 'session' + NAMESPACE_SEPARATOR + sanitizeNamespaceSegment(scope.sessionId);
  }
  return (
    prefix +
    NAMESPACE_SEPARATOR +
    'branch' +
    NAMESPACE_SEPARATOR +
    sanitizeNamespaceSegment(scope.sessionId) +
    NAMESPACE_SEPARATOR +
    sanitizeNamespaceSegment(scope.branchId)
  );
}

/**
 * Every namespace a scope may read, primary first: a branch reads its own
 * namespace, its session namespace and global; a session reads session+global;
 * global reads only global. Sibling branches are deliberately excluded.
 */
export function visibleNamespaces(scope: MemoryScope, namespacePrefix: string): string[] {
  const primary = deriveNamespace(scope, namespacePrefix);
  const result: string[] = [primary];
  if (scope.kind === 'branch') {
    const session = deriveNamespace({ kind: 'session', sessionId: scope.sessionId }, namespacePrefix);
    if (session !== primary) {
      result.push(session);
    }
  }
  if (scope.kind !== 'global') {
    const global = deriveNamespace({ kind: 'global' }, namespacePrefix);
    if (global !== primary) {
      result.push(global);
    }
  }
  return result;
}

/** Inline tag injected into entity names / text heads for namespace-blind backends. */
export function scopeInlineTag(namespace: string): string {
  return SCOPE_TAG_PREFIX + namespace + ']';
}

/** Read an inline scope tag back out of a backend payload, when present. */
export function extractScopeTag(text: string): string | undefined {
  const match = /\[SCOPE:([^\]]+)\]/.exec(text);
  return match === null || match[1] === undefined ? undefined : match[1];
}

/** True when a namespace belongs to the given session (branch or session scope). */
export function namespaceBelongsToSession(namespace: string, namespacePrefix: string, sessionId: string): boolean {
  const sessionPart = sanitizeNamespaceSegment(sessionId);
  const prefix = sanitizeNamespaceSegment(namespacePrefix);
  return (
    namespace === prefix + NAMESPACE_SEPARATOR + 'session' + NAMESPACE_SEPARATOR + sessionPart ||
    namespace.startsWith(prefix + NAMESPACE_SEPARATOR + 'branch' + NAMESPACE_SEPARATOR + sessionPart + NAMESPACE_SEPARATOR)
  );
}

/** True when a namespace is the exact branch-private namespace of one branch. */
export function namespaceIsBranch(
  namespace: string,
  namespacePrefix: string,
  sessionId: string,
  branchId: string
): boolean {
  const prefix = sanitizeNamespaceSegment(namespacePrefix);
  return (
    namespace ===
    prefix +
      NAMESPACE_SEPARATOR +
      'branch' +
      NAMESPACE_SEPARATOR +
      sanitizeNamespaceSegment(sessionId) +
      NAMESPACE_SEPARATOR +
      sanitizeNamespaceSegment(branchId)
  );
}

/** True when a namespace is the global namespace for the configured prefix. */
export function namespaceIsGlobal(namespace: string, namespacePrefix: string): boolean {
  return namespace === sanitizeNamespaceSegment(namespacePrefix) + NAMESPACE_SEPARATOR + 'global';
}
