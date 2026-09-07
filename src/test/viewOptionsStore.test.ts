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

test('defaults all view modes when nothing is stored', async () => {
  const store = new ViewOptionsStore(new MemoryStateStore());
  await store.load();
  assert.deepEqual(store.getSnapshot(), {
    version: 1,
    stock: 'default',
    fund: 'default',
    futures: 'default',
    holdingsSort: 'manual',
    holdingsSortDesc: true,
  });
});

test('persists view modes per kind and reloads them', async () => {
  const backing = new MemoryStateStore();
  const store = new ViewOptionsStore(backing);
  await store.load();
  await store.setViewMode('stock', 'gainDesc');
  await store.setViewMode('fund', 'lossDesc');
  await store.setViewMode('futures', 'upOnly');
  await store.setHoldingSort({ key: 'dayPercent', desc: false });

  const reloaded = new ViewOptionsStore(backing);
  await reloaded.load();
  assert.deepEqual(reloaded.getSnapshot(), {
    version: 1,
    stock: 'gainDesc',
    fund: 'lossDesc',
    futures: 'upOnly',
    holdingsSort: 'dayPercent',
    holdingsSortDesc: false,
  });
});

test('defaults the holdings sort for state stored before it existed', async () => {
  const store = new ViewOptionsStore(
    new MemoryStateStore({
      'fishStock.viewOptions.v1': {
        version: 1,
        stock: 'gainDesc',
        fund: 'default',
        futures: 'default',
        holdings: 'gainDesc',
      },
    }),
  );
  await store.load();
  assert.equal(store.getSnapshot().stock, 'gainDesc');
  // 旧版本只存 holdings 这个 mode，新代码读 holdingsSort，缺字段即回退默认顺序。
  assert.equal(store.getSnapshot().holdingsSort, 'manual');
  assert.equal(store.getSnapshot().holdingsSortDesc, true);
});

test('falls back to default for invalid stored modes', async () => {
  const store = new ViewOptionsStore(
    new MemoryStateStore({
      'fishStock.viewOptions.v1': {
        version: 1,
        stock: 'bogus',
        futures: 42,
        holdingsSort: 'nonsense',
        holdingsSortDesc: 'yes',
      },
    }),
  );
  await store.load();
  assert.deepEqual(store.getSnapshot(), {
    version: 1,
    stock: 'default',
    fund: 'default',
    futures: 'default',
    holdingsSort: 'manual',
    holdingsSortDesc: true,
  });
});

test('parses non-record stored values as defaults', () => {
  assert.deepEqual(parseViewOptionsState(undefined), {
    version: 1,
    stock: 'default',
    fund: 'default',
    futures: 'default',
    holdingsSort: 'manual',
    holdingsSortDesc: true,
  });
  assert.deepEqual(parseViewOptionsState('garbage'), {
    version: 1,
    stock: 'default',
    fund: 'default',
    futures: 'default',
    holdingsSort: 'manual',
    holdingsSortDesc: true,
  });
});
