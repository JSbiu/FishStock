import assert from 'node:assert/strict';
import test from 'node:test';
import type { Quote } from '../domain/models';
import { quoteDisplayKind } from '../domain/quotePresentation';

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: '600000.SH',
    market: 'CN',
    name: '浦发银行',
    currency: 'CNY',
    price: 10,
    previousClose: 9.9,
    open: 9.9,
    high: 10.1,
    low: 9.8,
    volume: 1,
    volumeUnit: 'share',
    turnoverAmount: 10,
    turnoverRate: 1,
    peTtm: 8,
    totalMarketCap: 100,
    settlementPrice: null,
    openInterest: null,
    change: 0.1,
    changePercent: 1,
    asOf: Date.now(),
    state: 'live',
    ...overrides,
  };
}

test('quote display kind gives suspension priority over every quote state', () => {
  for (const state of ['live', 'closed', 'stale'] as const) {
    assert.equal(quoteDisplayKind(quote({ state, suspended: true })), 'suspended');
  }
});

test('quote display kind restores the underlying state after resumption', () => {
  for (const state of ['live', 'closed', 'stale'] as const) {
    assert.equal(quoteDisplayKind(quote({ state, suspended: false })), state);
  }
});

test('quote display kind treats missing and errored quotes as unavailable', () => {
  assert.equal(quoteDisplayKind(undefined), 'unavailable');
  assert.equal(quoteDisplayKind(quote({ state: 'error' })), 'unavailable');
});
