import assert from 'node:assert/strict';
import test from 'node:test';
import type { StateStore } from '../storage/watchlistRepository';
import { parseViewOptionsState, ViewOptionsStore } from '../storage/viewOptionsStore';

class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, unknown>();

  public constructor(initial?: Record<string, unknown>) {
    if (initial) {
      for (const [key, value] of Object.entries(initial)) {
        this.values.set(key, value);
      }
    }
  }

  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

test('defaults both view modes when nothing is stored', async () => {
  const store = new ViewOptionsStore(new MemoryStateStore());
  await store.load();
  assert.deepEqual(store.getSnapshot(), {
    version: 1,
    stock: 'default',
    futures: 'default',
  });
});

test('persists view modes per kind and reloads them', async () => {
  const backing = new MemoryStateStore();
  const store = new ViewOptionsStore(backing);
  await store.load();
  await store.setViewMode('stock', 'gainDesc');
  await store.setViewMode('futures', 'upOnly');

  const reloaded = new ViewOptionsStore(backing);
  await reloaded.load();
  assert.deepEqual(reloaded.getSnapshot(), {
    version: 1,
    stock: 'gainDesc',
    futures: 'upOnly',
  });
});

test('falls back to default for invalid stored modes', async () => {
  const store = new ViewOptionsStore(
    new MemoryStateStore({
      'fishStock.viewOptions.v1': { version: 1, stock: 'bogus', futures: 42 },
    }),
  );
  await store.load();
  assert.deepEqual(store.getSnapshot(), {
    version: 1,
    stock: 'default',
    futures: 'default',
  });
});

test('parses non-record stored values as defaults', () => {
  assert.deepEqual(parseViewOptionsState(undefined), {
    version: 1,
    stock: 'default',
    futures: 'default',
  });
  assert.deepEqual(parseViewOptionsState('garbage'), {
    version: 1,
    stock: 'default',
    futures: 'default',
  });
});
