import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  MarketSession,
  NormalizedSymbol,
  RawMarketQuote,
} from '../domain/models';
import type { QuoteDataProvider } from '../data/marketDataProvider';
import { QuoteService } from '../data/quoteService';

const symbol: NormalizedSymbol = { symbol: '600519.SH', market: 'CN' };

function rawQuote(asOf: number): RawMarketQuote {
  return {
    symbol: symbol.symbol,
    market: symbol.market,
    name: '贵州茅台',
    currency: 'CNY',
    price: 1500,
    previousClose: 1490,
    asOf,
  };
}

test('reuses the short cache by fetch time even when a closed quote is old', async () => {
  let now = 1_000_000;
  let requests = 0;
  const provider: QuoteDataProvider = {
    id: 'test',
    displayName: '测试行情',
    async fetchQuotes() {
      requests += 1;
      return [rawQuote(100_000)];
    },
  };
  const service = new QuoteService(provider, 10_000, 120_000, () => now);

  await service.refresh([symbol]);
  now += 9_999;
  await service.refresh([symbol]);
  assert.equal(requests, 1);

  now += 1;
  await service.refresh([symbol]);
  assert.equal(requests, 2);
});

test('merges concurrent requests for the same normalized symbol set', async () => {
  let requests = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: QuoteDataProvider = {
    id: 'test',
    displayName: '测试行情',
    async fetchQuotes() {
      requests += 1;
      await gate;
      return [rawQuote(1_000_000)];
    },
  };
  const service = new QuoteService(provider, 10_000, 120_000, () => 1_000_000);

  const first = service.refresh([symbol]);
  const second = service.refresh([symbol, symbol]);
  assert.equal(requests, 1);
  release?.();
  await Promise.all([first, second]);
  assert.equal(requests, 1);
});

test('marks an open cached quote stale without changing its source timestamp', async () => {
  let now = 1_000_000;
  const provider: QuoteDataProvider = {
    id: 'test',
    displayName: '测试行情',
    async fetchQuotes() {
      return [rawQuote(1_000_000)];
    },
  };
  const service = new QuoteService(provider, 10_000, 120_000, () => now);

  await service.refresh([symbol]);
  assert.equal(service.get(symbol.symbol)?.state, 'live');
  now += 120_001;
  const stale = service.get(symbol.symbol);
  assert.equal(stale?.state, 'stale');
  assert.equal(stale?.asOf, 1_000_000);
});

test('derives live and closed states from the current market session', async () => {
  let now = 1_000_000;
  let session: MarketSession = {
    phase: 'trading',
    label: '上午交易',
    exact: true,
    currentSessionStartedAt: 900_000,
    lastSessionStartedAt: 900_000,
  };
  const provider: QuoteDataProvider = {
    id: 'test',
    displayName: '测试行情',
    async fetchQuotes() {
      return [rawQuote(950_000)];
    },
  };
  const service = new QuoteService(
    provider,
    10_000,
    120_000,
    () => now,
    () => session,
  );

  await service.refresh([symbol]);
  assert.deepEqual(
    [service.get(symbol.symbol)?.state, service.get(symbol.symbol)?.sessionLabel],
    ['live', '上午交易'],
  );

  session = {
    phase: 'break',
    label: '午休',
    exact: true,
    lastSessionStartedAt: 900_000,
    nextOpenAt: 1_100_000,
  };
  assert.deepEqual(
    [
      service.get(symbol.symbol)?.state,
      service.get(symbol.symbol)?.sessionLabel,
      service.get(symbol.symbol)?.nextOpenAt,
    ],
    ['closed', '午休', 1_100_000],
  );

  now += 1;
});

test('keeps valid closed data closed when a manual refresh fails', async () => {
  let fail = false;
  const provider: QuoteDataProvider = {
    id: 'test',
    displayName: '测试行情',
    async fetchQuotes() {
      if (fail) {
        throw new Error('network unavailable');
      }
      return [rawQuote(950_000)];
    },
  };
  const service = new QuoteService(
    provider,
    10_000,
    120_000,
    () => 1_000_000,
    () => ({
      phase: 'closed',
      label: '已收盘',
      exact: true,
      lastSessionStartedAt: 900_000,
    }),
  );

  await service.refresh([symbol]);
  fail = true;
  const result = await service.refresh([symbol], true);
  const quote = service.get(symbol.symbol);
  assert.equal(result.error, 'network unavailable');
  assert.equal(quote?.state, 'closed');
  assert.match(quote?.message ?? '', /最近刷新失败/);
});

test('marks cached data stale while trading after a refresh failure', async () => {
  let fail = false;
  const provider: QuoteDataProvider = {
    id: 'test',
    displayName: '测试行情',
    async fetchQuotes() {
      if (fail) {
        throw new Error('network unavailable');
      }
      return [rawQuote(990_000)];
    },
  };
  const service = new QuoteService(
    provider,
    10_000,
    120_000,
    () => 1_000_000,
    () => ({
      phase: 'trading',
      label: '上午交易',
      exact: true,
      currentSessionStartedAt: 900_000,
    }),
  );
  await service.refresh([symbol]);
  fail = true;
  await service.refresh([symbol], true);
  assert.equal(service.get(symbol.symbol)?.state, 'stale');
});

test('keeps cached data when a successful batch omits one requested symbol', async () => {
  let omit = false;
  const provider: QuoteDataProvider = {
    id: 'test',
    displayName: '测试行情',
    async fetchQuotes() {
      return omit ? [] : [rawQuote(990_000)];
    },
  };
  const service = new QuoteService(
    provider,
    10_000,
    120_000,
    () => 1_000_000,
    () => ({
      phase: 'trading',
      label: '上午交易',
      exact: true,
      currentSessionStartedAt: 900_000,
    }),
  );
  await service.refresh([symbol]);
  omit = true;
  const result = await service.refresh([symbol], true);

  assert.equal(result.error, '数据源未返回 1 个标的');
  assert.equal(service.get(symbol.symbol)?.price, 1500);
  assert.equal(service.get(symbol.symbol)?.state, 'stale');
  assert.match(service.get(symbol.symbol)?.message ?? '', /数据源未返回该标的/);
});

test('marks data stale when it misses the most recent closed session', async () => {
  const provider: QuoteDataProvider = {
    id: 'test',
    displayName: '测试行情',
    async fetchQuotes() {
      return [rawQuote(800_000)];
    },
  };
  const service = new QuoteService(
    provider,
    10_000,
    120_000,
    () => 1_000_000,
    () => ({
      phase: 'closed',
      label: '已收盘',
      exact: true,
      lastSessionStartedAt: 900_000,
    }),
  );
  await service.refresh([symbol]);
  assert.equal(service.get(symbol.symbol)?.state, 'stale');
  assert.match(service.get(symbol.symbol)?.message ?? '', /最近交易时段/);
});

test('exposes the exact time when a live quote will become stale', async () => {
  const provider: QuoteDataProvider = {
    id: 'test',
    displayName: '测试行情',
    async fetchQuotes() {
      return [rawQuote(1_000_000)];
    },
  };
  const service = new QuoteService(provider, 10_000, 120_000, () => 1_010_000);
  await service.refresh([symbol]);
  assert.equal(service.nextStateChangeAt(symbol.symbol, 1_010_000), 1_120_001);
  assert.equal(service.nextStateChangeAt(symbol.symbol, 1_120_001), undefined);
});
