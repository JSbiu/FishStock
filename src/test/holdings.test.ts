import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateHoldingMetrics,
  summarizeHoldingCurrency,
} from '../domain/holdings';
import type { Holding, Quote } from '../domain/models';

const holding: Holding = {
  id: 'one',
  symbol: '600519.SH',
  market: 'CN',
  kind: 'stock',
  name: '贵州茅台',
  quantity: 100,
  averageCost: 1_490,
};

function quote(price: number | null, state: Quote['state'] = 'live'): Quote {
  return {
    symbol: holding.symbol,
    market: holding.market,
    name: holding.name ?? holding.symbol,
    currency: 'CNY',
    price,
    previousClose: 1_480,
    open: null,
    high: null,
    low: null,
    volume: null,
    volumeUnit: null,
    turnoverAmount: null,
    turnoverRate: null,
    peTtm: null,
    totalMarketCap: null,
    settlementPrice: null,
    openInterest: null,
    change: price === null ? null : price - 1_480,
    changePercent: price === null ? null : ((price - 1_480) / 1_480) * 100,
    asOf: 1_000_000,
    state,
  };
}

test('calculates market value, floating profit and return percentage', () => {
  assert.deepEqual(calculateHoldingMetrics(holding, quote(1_500)), {
    currency: 'CNY',
    quantity: 100,
    averageCost: 1_490,
    currentPrice: 1_500,
    costValue: 149_000,
    marketValue: 150_000,
    profit: 1_000,
    returnPercent: (1_000 / 149_000) * 100,
  });
});

test('continues calculating with closed or stale prices but not missing prices', () => {
  assert.equal(calculateHoldingMetrics(holding, quote(1_500, 'closed'))?.profit, 1_000);
  assert.equal(calculateHoldingMetrics(holding, quote(1_500, 'stale'))?.profit, 1_000);
  assert.equal(calculateHoldingMetrics(holding, quote(1_500, 'error')), undefined);
  assert.equal(calculateHoldingMetrics(holding, quote(null, 'error')), undefined);
  assert.equal(calculateHoldingMetrics(holding, quote(0, 'error')), undefined);
  assert.equal(calculateHoldingMetrics(holding, undefined), undefined);
});

test('summarizes only priced holdings in the requested currency', () => {
  const unavailable: Holding = {
    ...holding,
    id: 'two',
    symbol: '000001.SZ',
    quantity: 200,
    averageCost: 10,
  };
  const summary = summarizeHoldingCurrency(
    'CNY',
    [holding, unavailable],
    (item) => item.id === holding.id ? quote(1_500) : undefined,
  );
  assert.deepEqual(summary, {
    currency: 'CNY',
    itemCount: 2,
    pricedItemCount: 1,
    costValue: 149_000,
    marketValue: 150_000,
    profit: 1_000,
    returnPercent: (1_000 / 149_000) * 100,
  });
});
