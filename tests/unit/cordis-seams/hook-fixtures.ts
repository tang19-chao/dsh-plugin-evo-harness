/**
 * Minimal Cordis/test-support fixture for the real DSH hook adapter tests.
 *
 * The fixture is a structural stand-in for a DeepSeek Harness context: it keeps
 * a listener registry with `on()`/`off()` semantics (including a `dispose()`
 * return value and a separate `off()` path, because hosts differ), exposes one
 * real DSH service (`systemPrompt`) so hook detection succeeds, and lets a test
 * dispatch a hook exactly the way the host waterfall does.
 *
 * No DSH runtime, network or LLM is involved.
 */
import { vi } from 'vitest';

/** Shape the assembly waterfall passes to its listeners. */
export interface AssemblyShape {
  sections: Array<{ name: string; text: string; interpolate?: boolean }>;
  contexts?: readonly unknown[];
  tools?: readonly unknown[];
  variables?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A recorded hook listener. */
export type HookListener = (...args: unknown[]) => unknown;

/** Fixture handle returned by createHookFixture(). */
export interface HookFixture {
  readonly ctx: Record<string, unknown> & { on: unknown };
  /** Call a registered listener by event name; throws when not registered. */
  listener(event: string): HookListener;
  /** Event names with a live listener, in registration order. */
  listenerNames(): string[];
  /** Number of times a listener was registered for an event. */
  registrationCount(event: string): number;
}

/** An empty assembly result, as a host with no contributions would return. */
export function emptyAssembly(): AssemblyShape {
  return { sections: [], contexts: [], tools: [], variables: {} };
}

/**
 * Build the fixture.
 *
 * `offSupported` selects how a disposer reaches the host: `true` returns a
 * disposer function from `on()`, `false` makes `on()` return a `{ dispose }`
 * object, and `'host-off'` makes `on()` return nothing so the adapter has to
 * fall back to the host's `off()`.
 */
export function createHookFixture(
  options: { readonly disposer?: 'function' | 'object' | 'host-off' } = {}
): HookFixture {
  const mode = options.disposer ?? 'function';
  const listeners = new Map<string, HookListener[]>();
  const registrations = new Map<string, number>();

  const remove = (event: string, listener: HookListener): void => {
    const current = listeners.get(event);
    if (current === undefined) {
      return;
    }
    const index = current.indexOf(listener);
    if (index >= 0) {
      current.splice(index, 1);
    }
    if (current.length === 0) {
      listeners.delete(event);
    }
  };

  const on = vi.fn((event: string, listener: HookListener): unknown => {
    const current = listeners.get(event) ?? [];
    current.push(listener);
    listeners.set(event, current);
    registrations.set(event, (registrations.get(event) ?? 0) + 1);
    if (mode === 'function') {
      return () => remove(event, listener);
    }
    if (mode === 'object') {
      return { dispose: () => remove(event, listener) };
    }
    return undefined;
  });

  const off = vi.fn((event: string, listener: HookListener): void => {
    remove(event, listener);
  });

  const ctx = {
    on,
    off,
    systemPrompt: {
      section: () => ({ dispose: () => undefined }),
      assemble: async () => emptyAssembly()
    },
    tools: {
      register: () => ({ dispose: () => undefined }),
      execute: async () => ({ content: [] })
    }
  } as Record<string, unknown> & { on: unknown };

  return {
    ctx,
    listener(event: string): HookListener {
      const entries = listeners.get(event);
      const listener = entries === undefined ? undefined : entries[0];
      if (listener === undefined) {
        throw new Error('no hook listener was registered for "' + event + '"');
      }
      return listener;
    },
    listenerNames(): string[] {
      return [...listeners.keys()];
    },
    registrationCount(event: string): number {
      return registrations.get(event) ?? 0;
    }
  };
}
