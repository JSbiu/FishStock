import assert from 'node:assert/strict';
import test from 'node:test';
import type { Quote, Stock } from '../domain/models';
import { applyViewOptions } from '../domain/viewOptions';

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
    ['1', '3', '2', '4'],
  );
});

test('keeps only falling stocks in down-only mode and preserves relative order', () => {
  assert.deepEqual(
    applyViewOptions(stocks, 'downOnly', quoteOf).map((item) => item.id),
    ['2', '1', '3', '4'],
  );
});

test('keeps uncovered stocks visible at the end in filter modes', () => {
  assert.deepEqual(
    applyViewOptions([stock('1'), stock('4')], 'upOnly', quoteOf).map((item) => item.id),
    ['1', '4'],
  );
});

test('does not mutate the input array', () => {
  const before = stocks.map((item) => item.id);
  applyViewOptions(stocks, 'gainDesc', quoteOf);
  assert.deepEqual(stocks.map((item) => item.id), before);
});
