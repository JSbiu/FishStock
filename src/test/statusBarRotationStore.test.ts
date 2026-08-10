import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseStatusBarRotationState,
  StatusBarRotationStore,
} from '../storage/statusBarRotationStore';
import type { StateStore } from '../storage/watchlistRepository';

class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, unknown>();

  public constructor(initial?: Record<string, unknown>) {
    for (const [key, value] of Object.entries(initial ?? {})) {
      this.values.set(key, value);
    }
  }

  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

test('includes every group by default', async () => {
  const store = new StatusBarRotationStore(new MemoryStateStore());
  await store.load();

  assert.equal(store.isGroupIncluded('stock', 'default'), true);
  assert.equal(store.isGroupIncluded('fund', 'default'), true);
  assert.equal(store.isGroupIncluded('futures', 'default'), true);
});

test('persists excluded groups independently for every view kind', async () => {
  const backing = new MemoryStateStore();
  const store = new StatusBarRotationStore(backing);
  await store.load();
  await store.setIncludedGroupIds(
    {
      stock: ['default', 'banks'],
      fund: ['default', 'industry'],
      futures: ['default'],
    },
    {
      stock: ['default'],
      fund: ['industry'],
      futures: [],
    },
  );

  const reloaded = new StatusBarRotationStore(backing);
  await reloaded.load();
  assert.equal(reloaded.isGroupIncluded('stock', 'default'), true);
  assert.equal(reloaded.isGroupIncluded('stock', 'banks'), false);
  assert.equal(reloaded.isGroupIncluded('fund', 'default'), false);
  assert.equal(reloaded.isGroupIncluded('fund', 'industry'), true);
  assert.equal(reloaded.isGroupIncluded('futures', 'default'), false);
});

test('new groups participate until the user excludes them', async () => {
  const store = new StatusBarRotationStore(new MemoryStateStore());
  await store.load();
  await store.setIncludedGroupIds(
    { stock: ['default'], fund: [], futures: [] },
    { stock: [], fund: [], futures: [] },
  );

  assert.equal(store.isGroupIncluded('stock', 'default'), false);
  assert.equal(store.isGroupIncluded('stock', 'new-group'), true);
});

test('sanitizes invalid persisted values', () => {
  assert.deepEqual(
    parseStatusBarRotationState({
      version: 99,
      excluded: {
        stock: [' default ', 'default', 42],
        fund: 'bad',
        futures: [null, 'main'],
      },
    }),
    {
      version: 1,
      excluded: {
        stock: ['default'],
        fund: [],
        futures: ['main'],
      },
    },
  );
  assert.deepEqual(parseStatusBarRotationState(undefined), {
    version: 1,
    excluded: { stock: [], fund: [], futures: [] },
  });
});
