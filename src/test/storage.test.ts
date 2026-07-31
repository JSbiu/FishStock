import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultFuturesWatchlist,
  createDefaultWatchlist,
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
      ['指数', ['000001.SHI', '000300.SHI', '399006.SZI']],
      [
        '银行',
        ['601398.SH', '601288.SH', '601988.SH', '601939.SH', '601328.SH', '601658.SH'],
      ],
      ['观察', ['600519.SH']],
    ],
  );
});

test('creates the expected grouped first-run watchlist', () => {
  const state = createDefaultWatchlist();
  assert.deepEqual(
    state.groups.map((group) => [
      group.name,
      group.stocks.map((stock) => [stock.name, stock.symbol]),
    ]),
    [
      [
        '默认',
        [
          ['贵州茅台', '600519.SH'],
          ['腾讯控股', '00700.HK'],
        ],
      ],
      [
        '指数',
        [
          ['上证指数', '000001.SHI'],
          ['沪深300', '000300.SHI'],
          ['创业板指', '399006.SZI'],
        ],
      ],
      [
        '银行',
        [
          ['工商银行', '601398.SH'],
          ['农业银行', '601288.SH'],
          ['中国银行', '601988.SH'],
          ['建设银行', '601939.SH'],
          ['交通银行', '601328.SH'],
          ['邮储银行', '601658.SH'],
        ],
      ],
    ],
  );
});

test('creates the expected first-run futures watchlist', () => {
  const state = createDefaultFuturesWatchlist();
  assert.deepEqual(
    state.groups.map((group) => [
      group.name,
      group.stocks.map((future) => [future.name, future.symbol]),
    ]),
    [
      [
        '默认',
        [
          ['沪金主连', 'AU0.CNF'],
          ['白银主连', 'AG0.CNF'],
          ['铜主连', 'CU0.CNF'],
          ['沪铝主连', 'AL0.CNF'],
          ['锡主连', 'SN0.CNF'],
        ],
      ],
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

test('persists an index separately from a stock with the same numeric code', async () => {
  const store = new MemoryStateStore();
  const repository = new WatchlistRepository(store);
  await repository.load();
  await repository.addStock('default', {
    id: 'sz-stock',
    symbol: '000001.SZ',
    market: 'CN',
    name: '平安银行',
  });

  const reloaded = new WatchlistRepository(store);
  const symbols = (await reloaded.load()).groups.flatMap((group) =>
    group.stocks.map((stock) => stock.symbol),
  );
  assert.equal(symbols.includes('000001.SHI'), true);
  assert.equal(symbols.includes('000001.SZ'), true);
});

test('clears persisted data to one empty default group', async () => {
  const store = new MemoryStateStore();
  const repository = new WatchlistRepository(store);
  await repository.load();
  await repository.addGroup('group-2', '观察');
  await repository.clear();

  assert.deepEqual(repository.getSnapshot(), {
    version: 1,
    groups: [
      {
        id: 'default',
        name: '默认',
        collapsed: false,
        stocks: [],
      },
    ],
  });

  const reloaded = new WatchlistRepository(store);
  assert.deepEqual(await reloaded.load(), repository.getSnapshot());
});

test('restores the persisted first-run default watchlist', async () => {
  const store = new MemoryStateStore();
  const repository = new WatchlistRepository(store);
  await repository.load();
  await repository.addGroup('group-2', '观察');
  await repository.removeStock('sample-cn');
  await repository.restoreDefault();

  assert.deepEqual(repository.getSnapshot(), createDefaultWatchlist());
  const reloaded = new WatchlistRepository(store);
  assert.deepEqual(await reloaded.load(), createDefaultWatchlist());
});

test('rejects invalid persisted watchlist states', () => {
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
    /证券代码重复/,
  );
});

test('keeps futures data in an independent local namespace', async () => {
  const store = new MemoryStateStore();
  const stocks = new WatchlistRepository(store);
  const futures = new WatchlistRepository(store, {
    storageKey: 'fishStock.futures.v1',
    createDefault: createDefaultFuturesWatchlist,
  });
  await Promise.all([stocks.load(), futures.load()]);
  await futures.addStock('default', {
    id: 'future-rb-main',
    symbol: 'RB0.CNF',
    market: 'CNF',
    name: '螺纹钢主连',
  });

  assert.equal(stocks.getSnapshot().groups.some((group) => group.stocks.some((item) => item.symbol === 'RB0.CNF')), false);
  assert.equal(futures.getSnapshot().groups[0].stocks.at(-1)?.symbol, 'RB0.CNF');
});

test('clears and restores futures defaults independently', async () => {
  const store = new MemoryStateStore();
  const futures = new WatchlistRepository(store, {
    storageKey: 'fishStock.futures.v1',
    createDefault: createDefaultFuturesWatchlist,
  });
  await futures.load();
  await futures.clear();
  assert.deepEqual(futures.getSnapshot().groups[0].stocks, []);

  await futures.restoreDefault();
  assert.deepEqual(futures.getSnapshot(), createDefaultFuturesWatchlist());
});
