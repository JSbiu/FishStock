import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  NormalizedSymbol,
  RawMarketQuote,
} from '../domain/models';
import type { QuoteDataProvider } from '../data/marketDataProvider';
import { QuoteService } from '../data/quoteService';

const symbol: NormalizedSymbol = { symbol: '600519.SH', market: 'CN' };

function rawQuote(asOf: number, marketState: 'open' | 'closed' = 'open'): RawMarketQuote {
  return {
    symbol: symbol.symbol,
    market: symbol.market,
    name: '贵州茅台',
    currency: 'CNY',
    price: 1500,
    previousClose: 1490,
    asOf,
    marketState,
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
      return [rawQuote(100_000, 'closed')];
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
