import { describe, expect, it, vi } from 'vitest';
import {
  CordisSeamError,
  DisposableRegistry,
  safeDispose
} from '../../../src/cordis-seams';

describe('DisposableRegistry', () => {
  it('disposes registered effects in reverse registration order', async () => {
    const order: string[] = [];
    const registry = new DisposableRegistry();
    registry.register('first', () => {
      order.push('first');
    });
    registry.register('second', () => {
      order.push('second');
    });
    registry.register('third', () => {
      order.push('third');
    });

    expect(registry.size).toBe(3);
    const failures = await registry.disposeAll();

    expect(failures).toEqual([]);
    expect(order).toEqual(['third', 'second', 'first']);
    expect(registry.size).toBe(0);
    expect(registry.isDisposed).toBe(true);
  });

  it('is idempotent: repeated disposeAll runs each disposer once', async () => {
    const dispose = vi.fn();
    const registry = new DisposableRegistry();
    registry.register('only', dispose);

    const first = await registry.disposeAll();
    const second = await registry.disposeAll();

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('continues unwinding after a failing disposer and reports every failure', async () => {
    const survivor = vi.fn();
    const registry = new DisposableRegistry();
    registry.register('survivor', survivor);
    registry.register('broken', () => {
      throw new Error('boom');
    });

    const failures = await registry.disposeAll();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.label).toBe('broken');
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(registry.disposalFailures).toHaveLength(1);
  });

  it('supports early release without double disposal', async () => {
    const dispose = vi.fn();
    const registry = new DisposableRegistry();
    const release = registry.register('early', dispose);

    expect(registry.size).toBe(1);
    await release();
    await release();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);

    await registry.disposeAll();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('throws when registering on a disposed registry', async () => {
    const registry = new DisposableRegistry();
    await registry.disposeAll();

    expect(() => registry.register('late', () => undefined)).toThrowError(CordisSeamError);
    try {
      registry.register('late', () => undefined);
    } catch (error) {
      expect((error as CordisSeamError).code).toBe('registry_disposed');
    }
  });

  it('disposeOrThrow surfaces collected failures as a typed error', async () => {
    const registry = new DisposableRegistry();
    registry.register('broken', () => {
      throw new Error('boom');
    });

    await expect(registry.disposeOrThrow()).rejects.toMatchObject({ code: 'dispose_failed' });
  });

  it('safeDispose normalizes success and failure without throwing', async () => {
    await expect(safeDispose('ok', () => undefined)).resolves.toBeNull();
    const failure = await safeDispose('bad', () => {
      throw new Error('nope');
    });
    expect(failure?.label).toBe('bad');
    await expect(safeDispose('none', undefined)).resolves.toBeNull();
  });
});
