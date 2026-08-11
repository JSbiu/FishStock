import assert from 'node:assert/strict';
import test from 'node:test';
import { startBackgroundRefresh } from '../services/backgroundRefresh';

test('starts initial refresh without waiting for the network task to settle', async () => {
  let release: (() => void) | undefined;
  let completed = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const result = startBackgroundRefresh(async () => {
    await gate;
    completed = true;
  }, (error) => {
    assert.fail(error instanceof Error ? error.message : String(error));
  });

  assert.equal(result, undefined);
  assert.equal(completed, false);

  release?.();
  await gate;
  await Promise.resolve();
  assert.equal(completed, true);
});

test('reports an unexpected background refresh failure', async () => {
  const expected = new Error('refresh failed');
  const reported = new Promise<unknown>((resolve) => {
    startBackgroundRefresh(async () => {
      throw expected;
    }, resolve);
  });

  assert.equal(await reported, expected);
});
