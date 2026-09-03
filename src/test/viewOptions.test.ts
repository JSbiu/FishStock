import assert from 'node:assert/strict';
import test from 'node:test';
import type { Holding, Quote, Stock } from '../domain/models';
import { applyHoldingViewOptions, applyViewOptions } from '../domain/viewOptions';

function stock(id: string): Stock {
  return { id, symbol: `600${id}.SH`, market: 'CN', name: `股票${id}` };
}

function quote(changePercent: number): Quote {
  return {
    symbol: 'x',
    market: 'CN',
    name: 'x',
    currency: 'CNY',
    price: 10,
    previousClose: 10,
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
    change: 0,
    changePercent,
    asOf: 0,
    state: 'live',
  };
}

const stocks = [stock('1'), stock('2'), stock('3'), stock('4')];
const changeOf: Readonly<Record<string, number>> = { '6001.SH': 3, '6002.SH': -1, '6003.SH': 3 };
const quoteOf = (symbol: string): Quote | undefined => {
  const change = changeOf[symbol];
  return change === undefined ? undefined : quote(change);
};

test('keeps the original order in default mode', () => {
  assert.deepEqual(
    applyViewOptions(stocks, 'default', quoteOf).map((item) => item.id),
    ['1', '2', '3', '4'],
  );
});

test('sorts by change percent descending and keeps uncovered quotes last', () => {
  assert.deepEqual(
    applyViewOptions(stocks, 'gainDesc', quoteOf).map((item) => item.id),
    ['1', '3', '2', '4'],
  );
});

test('sorts by change percent ascending and keeps uncovered quotes last', () => {
  assert.deepEqual(
    applyViewOptions(stocks, 'lossDesc', quoteOf).map((item) => item.id),
    ['2', '1', '3', '4'],
  );
});

test('keeps only rising stocks in up-only mode and preserves relative order', () => {
  assert.deepEqual(
    applyViewOptions(stocks, 'upOnly', quoteOf).map((item) => item.id),
    ['1', '3'],
  );
});

test('keeps only falling stocks in down-only mode and preserves relative order', () => {
  assert.deepEqual(
    applyViewOptions(stocks, 'downOnly', quoteOf).map((item) => item.id),
    ['2'],
  );
});

test('hides flat and uncovered stocks in filter modes', () => {
  assert.deepEqual(
    applyViewOptions([stock('1'), stock('4')], 'upOnly', (symbol) =>
      symbol === '6001.SH' ? quote(0) : undefined,
    ).map((item) => item.id),
    [],
  );
});

test('does not mutate the input array', () => {
  const before = stocks.map((item) => item.id);
  applyViewOptions(stocks, 'gainDesc', quoteOf);
  assert.deepEqual(stocks.map((item) => item.id), before);
});

function holding(
  id: string,
  quantity: number,
  averageCost: number,
): Holding {
  return {
    id,
    symbol: `600${id}.SH`,
    market: 'CN',
    kind: 'stock',
    name: `持仓${id}`,
    quantity,
    averageCost,
  };
}

function pricedQuote(symbol: string, price: number, previousClose = 10): Quote {
  return {
    ...quote(0),
    symbol,
    price,
    previousClose,
    change: price - previousClose,
    changePercent: ((price - previousClose) / previousClose) * 100,
  };
}

const priced: Record<string, number> = { '6001.SH': 12, '6002.SH': 8, '6003.SH': 12 };
const holdingQuoteOf = (item: Holding): Quote | undefined => {
  const price = priced[item.symbol];
  return price === undefined ? undefined : pricedQuote(item.symbol, price);
};

const holdings = [
  holding('1', 100, 10),
  holding('2', 100, 10),
  holding('3', 100, 10),
  holding('4', 100, 10),
];

test('keeps the original holdings order in default mode', () => {
  assert.deepEqual(
    applyHoldingViewOptions(holdings, 'default', holdingQuoteOf).map((item) => item.id),
    ['1', '2', '3', '4'],
  );
});

test('sorts holdings by return rate descending and keeps unpriced last', () => {
  assert.deepEqual(
    applyHoldingViewOptions(holdings, 'gainDesc', holdingQuoteOf).map((item) => item.id),
    ['1', '3', '2', '4'],
  );
});

test('sorts holdings by return rate ascending and keeps unpriced last', () => {
  assert.deepEqual(
    applyHoldingViewOptions(holdings, 'lossDesc', holdingQuoteOf).map((item) => item.id),
    ['2', '1', '3', '4'],
  );
});

test('keeps only profitable holdings in up-only mode', () => {
  assert.deepEqual(
    applyHoldingViewOptions(holdings, 'upOnly', holdingQuoteOf).map((item) => item.id),
    ['1', '3'],
  );
});

test('keeps only losing holdings in down-only mode', () => {
  assert.deepEqual(
    applyHoldingViewOptions(holdings, 'downOnly', holdingQuoteOf).map((item) => item.id),
    ['2'],
  );
});

test('ranks holdings by return rate rather than by daily change', () => {
  const cheapCost = holding('b', 100, 5);
  const highCost = holding('a', 100, 10);
  const quotes: Record<string, number> = { '600a.SH': 11, '600b.SH': 8 };
  const quoteFor = (item: Holding): Quote | undefined =>
    pricedQuote(item.symbol, quotes[item.symbol]);
  assert.deepEqual(
    applyHoldingViewOptions([highCost, cheapCost], 'gainDesc', quoteFor).map((item) => item.id),
    ['b', 'a'],
  );
});

test('does not mutate the holdings input array', () => {
  const before = holdings.map((item) => item.id);
  applyHoldingViewOptions(holdings, 'gainDesc', holdingQuoteOf);
  assert.deepEqual(holdings.map((item) => item.id), before);
});
