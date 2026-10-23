/**
 * t27 rebuild-audit regression test: durable task-counter wiring.
 *
 * The orchestrator was rebuilt by hand; the persistence branch is exactly the
 * region that broke. These tests pin the contract that survived the rebuild:
 * one recordCompletedTask per successful run, the durable counter is the
 * authoritative shouldDream source, recordDream runs once per actual dream, and
 * a failed run records nothing.
 */
import { describe, expect, it } from 'vitest';
import { buildE2E } from '../../e2e/fixtures';
import type { OrchestratorTaskCounter } from '../../../src/orchestrator';

interface CounterHarness {
  readonly counter: OrchestratorTaskCounter;
  readonly calls: { shouldDream: number; recordCompleted: number; recordDream: number };
  setDue(value: boolean): void;
}

function makeCounter(): CounterHarness {
  let completed = 0;
  let dreams = 0;
  let due = false;
  const calls = { shouldDream: 0, recordCompleted: 0, recordDream: 0 };
  return {
    calls,
    setDue: (value: boolean) => {
      due = value;
    },
    counter: {
      shouldDream: () => {
        calls.shouldDream += 1;
        return due;
      },
      recordCompletedTask: async () => {
        calls.recordCompleted += 1;
        completed += 1;
        return completed;
      },
      recordDream: async () => {
        calls.recordDream += 1;
        dreams += 1;
        return dreams;
      }
    }
  };
}

function task(plugin: ReturnType<typeof buildE2E>['plugin']) {
  return plugin.makeTask({
    id: 'task-counter',
    prompt: 'Fix the failing build without breaking the release train.',
    taskSignature: 'build-failure',
    contextTags: ['ci']
  });
}

describe('orchestrator durable task counter (t27 audit)', () => {
  it('records exactly one completed task per successful run and skips the dream when not due', async () => {
    const counter = makeCounter();
    const harness = buildE2E({ extra: { deps: { taskCounter: counter.counter } } });
    const result = await harness.plugin.run({
      sessionId: 'sess-counter-1',
      task: task(harness.plugin),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    expect(counter.calls.recordCompleted).toBe(1);
    expect(counter.calls.shouldDream).toBe(1);
    expect(counter.calls.recordDream).toBe(0);
    expect(result.metadata?.dreamTriggered).toBe(false);
  });

  it('records one dream when due without re-counting the same task', async () => {
    const counter = makeCounter();
    counter.setDue(true);
    const harness = buildE2E({ extra: { deps: { taskCounter: counter.counter } } });
    const result = await harness.plugin.run({
      sessionId: 'sess-counter-2',
      task: task(harness.plugin),
      trigger: 'always'
    });
    expect(result.outcome).toBe('composed');
    expect(counter.calls.recordCompleted).toBe(1);
    expect(counter.calls.recordDream).toBe(1);
    expect(result.metadata?.dreamTriggered).toBe(true);
    // The task itself is counted once; the dream counter is a separate counter.
    expect(counter.calls.recordCompleted).not.toBe(2);
  });

  it('records nothing when the lifecycle fails before finalize', async () => {
    const counter = makeCounter();
    const harness = buildE2E({
      extra: {
        deps: {
          taskCounter: counter.counter,
          reflector: {
            reflect: async () => {
              throw new Error('reflect exploded');
            }
          }
        }
      }
    });
    const result = await harness.plugin.run({
      sessionId: 'sess-counter-3',
      task: task(harness.plugin),
      trigger: 'always'
    });
    expect(result.outcome).toBe('failed');
    expect(result.diagnostics.join(' ')).toContain('lifecycle failed');
    expect(counter.calls.recordCompleted).toBe(0);
    expect(counter.calls.shouldDream).toBe(0);
  });
});
