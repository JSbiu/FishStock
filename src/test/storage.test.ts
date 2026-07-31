import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWatchlistState,
  WatchlistRepository,
  WatchlistValidationError,
  type StateStore,
} from '../storage/watchlistRepository';

class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, unknown>();

  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

test('persists groups, stock order and stock moves between repository instances', async () => {
  const store = new MemoryStateStore();
  const first = new WatchlistRepository(store);
  await first.load();
  await first.addGroup('group-2', '观察');
  await first.moveStock('sample-hk', -1);
  await first.moveStockToGroup('sample-cn', 'group-2');

  const second = new WatchlistRepository(store);
  const state = await second.load();
  assert.deepEqual(
    state.groups.map((group) => [group.name, group.stocks.map((stock) => stock.symbol)]),
    [
      ['默认', ['00700.HK']],
      ['观察', ['600519.SH']],
    ],
  );
});
test('prevents duplicate stock symbols across groups', async () => {
  const repository = new WatchlistRepository(new MemoryStateStore());
  await repository.load();
  await assert.rejects(
    repository.addStock('default', {
      id: 'duplicate',
      symbol: 'sh600519',
      market: 'CN',
    }),
    WatchlistValidationError,
  );
});

test('rejects invalid import payloads', () => {
  assert.throws(
    () =>
      parseWatchlistState({
        version: 1,
        groups: [
          {
            id: 'one',
            name: '一',
            collapsed: false,
            stocks: [{ id: 'a', symbol: '600519', market: 'CN' }],
          },
          {
            id: 'two',
            name: '二',
            collapsed: false,
            stocks: [{ id: 'b', symbol: '600519.SH', market: 'CN' }],
          },
        ],
      }),
    /股票代码重复/,
  );
});
