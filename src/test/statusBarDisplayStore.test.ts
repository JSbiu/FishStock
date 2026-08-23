import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseStatusBarDisplayState,
  StatusBarDisplayStore,
} from '../storage/statusBarDisplayStore';
import type { StateStore } from '../storage/watchlistRepository';

class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, unknown>();

  public constructor(initial?: unknown) {
    if (initial !== undefined) {
      this.values.set('fishStock.statusBarDisplay.v1', initial);
    }
  }

  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

test('defaults to the existing quote rotation experience', async () => {
  const store = new StatusBarDisplayStore(new MemoryStateStore());
  assert.deepEqual(await store.load(), { version: 1, mode: 'quotes' });
});

test('persists the opt-in holdings profit mode', async () => {
  const backing = new MemoryStateStore();
  const first = new StatusBarDisplayStore(backing);
  await first.load();
  await first.setMode('holdings');

  const second = new StatusBarDisplayStore(backing);
  assert.equal((await second.load()).mode, 'holdings');
});

test('sanitizes unknown persisted modes', () => {
  assert.deepEqual(parseStatusBarDisplayState({ version: 99, mode: 'mixed' }), {
    version: 1,
    mode: 'quotes',
  });
  assert.deepEqual(parseStatusBarDisplayState({ version: 2, mode: 'holdings' }), {
    version: 1,
    mode: 'quotes',
  });
});
