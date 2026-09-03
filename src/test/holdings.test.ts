import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateHoldingMetrics,
  holdingDayChange,
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

function quote(
  price: number | null,
  state: Quote['state'] = 'live',
  overrides: Partial<Quote> = {},
): Quote {
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
    ...overrides,
  };
}

const TRADING_DAY = '2026-09-03';
const SESSION_START = Date.parse('2026-09-03T09:15:00+08:00');
const SAME_DAY_QUOTE_AT = Date.parse('2026-09-03T10:00:00+08:00');
const PREVIOUS_DAY_QUOTE_AT = Date.parse('2026-09-02T15:00:00+08:00');
const NOW = new Date('2026-09-03T10:00:00+08:00');

function sameDayQuote(
  price: number | null,
  state: Quote['state'],
  asOf: number = SAME_DAY_QUOTE_AT,
): Quote {
  return quote(price, state, {
    tradingDate: TRADING_DAY,
    quoteValidSince: SESSION_START,
    asOf,
  });
}

test('calculates market value, floating profit and return percentage', () => {
  assert.deepEqual(calculateHoldingMetrics(holding, quote(1_500)), {
    currency: 'CNY',
    quantity: 100,
    averageCost: 1_490,
    currentPrice: 1_500,
    costValue: 149_000,
    marketValue: 150_000,
    previousValue: 148_000,
    profit: 1_000,
    returnPercent: (1_000 / 149_000) * 100,
    dayProfit: null,
    dayProfitPercent: null,
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
    dayProfit: null,
    dayProfitPercent: null,
  });
});

test('computes day profit from a quote that belongs to the current trading day', () => {
  assert.equal(holdingDayChange(sameDayQuote(1_500, 'live'), NOW), 20);
  assert.equal(
    calculateHoldingMetrics(holding, sameDayQuote(1_500, 'live'), NOW)?.dayProfit,
    2_000,
  );
});

test('keeps the last same-day quote when refreshing is overdue', () => {
  assert.equal(holdingDayChange(sameDayQuote(1_500, 'stale'), NOW), 20);
  assert.equal(
    calculateHoldingMetrics(holding, sameDayQuote(1_500, 'stale'), NOW)?.dayProfit,
    2_000,
  );
});

test('keeps day profit once the session is closed for the day', () => {
  assert.equal(holdingDayChange(sameDayQuote(1_500, 'closed'), NOW), 20);
});

test('drops day profit when the cached quote predates the current trading day', () => {
  assert.equal(
    holdingDayChange(sameDayQuote(1_500, 'stale', PREVIOUS_DAY_QUOTE_AT), NOW),
    null,
  );
});

test('drops day profit when the quote belongs to another trading day', () => {
  const previousDay = quote(1_500, 'closed', {
    tradingDate: '2026-09-02',
    quoteValidSince: Date.parse('2026-09-02T09:15:00+08:00'),
    asOf: PREVIOUS_DAY_QUOTE_AT,
  });
  assert.equal(holdingDayChange(previousDay, NOW), null);
});

test('drops day profit when the quote carries no change', () => {
  assert.equal(holdingDayChange(sameDayQuote(null, 'error'), NOW), null);
});

test('summarizes day profit only from holdings with a same-day quote', () => {
  const other: Holding = {
    ...holding,
    id: 'two',
    symbol: '000001.SZ',
    quantity: 200,
    averageCost: 10,
  };
  const summary = summarizeHoldingCurrency(
    'CNY',
    [holding, other],
    (item) => (item.id === holding.id ? sameDayQuote(1_500, 'live') : quote(12, 'stale')),
    NOW,
  );
  assert.equal(summary.dayProfit, 2_000);
  assert.equal(summary.dayProfitPercent, (2_000 / 148_000) * 100);
});

test('reports no day profit when every holding lacks a same-day quote', () => {
  const summary = summarizeHoldingCurrency('CNY', [holding], () => quote(1_500, 'stale'), NOW);
  assert.equal(summary.dayProfit, null);
  assert.equal(summary.dayProfitPercent, null);
});

test('measures day profit percentage against the previous close value', () => {
  const metrics = calculateHoldingMetrics(holding, sameDayQuote(1_500, 'live'), NOW);
  assert.equal(metrics?.previousValue, 148_000);
  assert.equal(metrics?.dayProfit, 2_000);
  assert.equal(metrics?.dayProfitPercent, (2_000 / 148_000) * 100);
});

test('bases the summarized day profit percentage only on same-day holdings', () => {
  const outdated: Holding = {
    ...holding,
    id: 'two',
    symbol: '000001.SZ',
    quantity: 100,
    averageCost: 10,
  };
  const summary = summarizeHoldingCurrency(
    'CNY',
    [holding, outdated],
    (item) => (item.id === holding.id ? sameDayQuote(1_500, 'live') : quote(12, 'stale')),
    NOW,
  );
  assert.equal(summary.dayProfit, 2_000);
  assert.equal(summary.dayProfitPercent, (2_000 / 148_000) * 100);
});
