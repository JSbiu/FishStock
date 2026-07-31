import assert from 'node:assert/strict';
import test from 'node:test';
import { RefreshScheduler } from '../services/refreshScheduler';

test('merges scheduler triggers while one refresh task is active', async () => {
  let runs = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = new RefreshScheduler(60_000, async () => {
    runs += 1;
    await gate;
  });

  const first = scheduler.trigger();
  const second = scheduler.trigger();
  assert.equal(first, second);
  assert.equal(runs, 1);

  release?.();
  await first;
  await scheduler.trigger();
  assert.equal(runs, 2);
  scheduler.dispose();
});
