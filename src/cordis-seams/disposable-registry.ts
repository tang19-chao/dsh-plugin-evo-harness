/**
 * LIFO, idempotent disposal registry.
 *
 * Every reversible effect mounted by the seam layer (host seam disposers, forked
 * child contexts, sandbox workspaces, timers, abort listeners) is registered here
 * so that success, failure, timeout and abort all unwind through one code path.
 * Disposal continues after an individual failure and reports every failure, so a
 * single broken seam can never leak the rest of the branch.
 */
import { CordisSeamError } from './errors';

/** A disposal callback. */
export type DisposeFn = () => void | Promise<void>;

/** Anything exposing an idempotent dispose(). */
export interface DisposableLike {
  dispose(): void | Promise<void>;
}

/** One failed disposal. */
export interface DisposalFailure {
  readonly label: string;
  readonly error: unknown;
}

interface RegistryEntry {
  readonly label: string;
  readonly dispose: DisposeFn;
  readonly order: number;
}

/**
 * Run one disposer, converting a throw into a DisposalFailure.
 * Never throws, so cleanup always proceeds to the next entry.
 */
export async function safeDispose(
  label: string,
  target: DisposableLike | DisposeFn | null | undefined
): Promise<DisposalFailure | null> {
  if (target === null || target === undefined) {
    return null;
  }
  try {
    if (typeof target === 'function') {
      await target();
    } else {
      await target.dispose();
    }
    return null;
  } catch (error) {
    return { label, error };
  }
}

/** LIFO registry with idempotent, failure-tolerant disposal. */
export class DisposableRegistry {
  private readonly entries: RegistryEntry[] = [];
  private readonly released = new Set<number>();
  private sequence = 0;
  private disposed = false;
  private disposal: Promise<readonly DisposalFailure[]> | null = null;
  private failures: readonly DisposalFailure[] = [];

  /** Number of effects still waiting for disposal. */
  get size(): number {
    return this.entries.length;
  }

  /** True once disposeAll() has been called. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Failures observed during the single disposal pass. */
  get disposalFailures(): readonly DisposalFailure[] {
    return this.failures;
  }

  /**
   * Register a disposer. Returns an idempotent release function that disposes
   * this single entry early (and removes it from the pending set). Registering
   * after disposal is a programming error and throws.
   */
  register(label: string, dispose: DisposeFn): DisposeFn {
    if (this.disposed) {
      throw new CordisSeamError(
        'Cannot register disposer "' + label + '" on a disposed registry.',
        { code: 'registry_disposed', details: { label } }
      );
    }
    const entry: RegistryEntry = { label, dispose, order: this.sequence };
    this.sequence += 1;
    this.entries.push(entry);
    return async (): Promise<void> => {
      const failure = await this.disposeEntry(entry);
      if (failure !== null) {
        throw new CordisSeamError(
          'Failed to dispose registered effect "' + failure.label + '".',
          { code: 'dispose_failed', cause: failure.error, details: { label: failure.label } }
        );
      }
    };
  }

  /** Convenience wrapper for register() over an object with dispose(). */
  add(label: string, disposable: DisposableLike): DisposeFn {
    return this.register(label, () => disposable.dispose());
  }

  /** Dispose every pending entry in reverse registration order. Idempotent. */
  async disposeAll(): Promise<readonly DisposalFailure[]> {
    if (this.disposal !== null) {
      return this.disposal;
    }
    this.disposed = true;
    const pending = this.entries.slice().reverse();
    this.entries.length = 0;
    this.disposal = (async (): Promise<readonly DisposalFailure[]> => {
      const failures: DisposalFailure[] = [];
      for (const entry of pending) {
        const failure = await this.disposeEntry(entry);
        if (failure !== null) {
          failures.push(failure);
        }
      }
      this.failures = failures;
      return failures;
    })();
    return this.disposal;
  }

  /** Dispose everything and throw if any effect failed to unwind. */
  async disposeOrThrow(): Promise<void> {
    const failures = await this.disposeAll();
    if (failures.length > 0) {
      const first = failures[0];
      throw new CordisSeamError(
        'Failed to dispose ' + failures.length + ' registered effect(s).',
        {
          code: 'dispose_failed',
          cause: first === undefined ? undefined : first.error,
          details: { labels: failures.map((failure) => failure.label) }
        }
      );
    }
  }

  private async disposeEntry(entry: RegistryEntry): Promise<DisposalFailure | null> {
    if (this.released.has(entry.order)) {
      return null;
    }
    this.released.add(entry.order);
    const index = this.entries.indexOf(entry);
    if (index >= 0) {
      this.entries.splice(index, 1);
    }
    return safeDispose(entry.label, entry.dispose);
  }
}
