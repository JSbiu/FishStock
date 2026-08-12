import assert from 'node:assert/strict';
import test from 'node:test';
import type { RawMarketQuote } from '../domain/models';
import { parseMarketQuote, QuoteParseError } from '../data/quoteParser';

function quote(overrides: Partial<RawMarketQuote> = {}): RawMarketQuote {
  return {
    symbol: '600519.SH',
    market: 'CN',
    name: '示例股票',
    currency: 'CNY',
    price: '102.50',
    previousClose: '100',
    open: '101',
    high: '103',
    low: '99.50',
    volume: '123456',
    volumeUnit: 'lot',
    turnoverAmount: '987654321',
    turnoverRate: '1.25',
    peTtm: '18.75',
    totalMarketCap: '200000000000',
    asOf: '2026-07-31T01:30:00.000Z',
    ...overrides,
  };
}

test('parses and calculates quote change from source values', () => {
  const parsed = parseMarketQuote(quote());
  assert.equal(parsed.symbol, '600519.SH');
  assert.equal(parsed.price, 102.5);
  assert.equal(parsed.change, 2.5);
  assert.equal(parsed.changePercent, 2.5);
  assert.equal(parsed.open, 101);
  assert.equal(parsed.high, 103);
  assert.equal(parsed.low, 99.5);
  assert.equal(parsed.volume, 123456);
  assert.equal(parsed.volumeUnit, 'lot');
  assert.equal(parsed.turnoverAmount, 987654321);
  assert.equal(parsed.turnoverRate, 1.25);
  assert.equal(parsed.peTtm, 18.75);
  assert.equal(parsed.totalMarketCap, 200000000000);
  assert.equal(parsed.state, 'live');
});
test('rejects invalid numeric fields and market mismatches', () => {
  assert.throws(() => parseMarketQuote(quote({ price: 'NaN' })), QuoteParseError);
  assert.throws(() => parseMarketQuote(quote({ market: 'HK' })), QuoteParseError);
});

test('keeps negative PE TTM and ignores unusable optional metrics', () => {
  const parsed = parseMarketQuote(
    quote({
      open: '0',
      high: 'invalid',
      volume: '-1',
      peTtm: '-12.30',
      totalMarketCap: '',
    }),
  );
  assert.equal(parsed.open, null);
  assert.equal(parsed.high, null);
  assert.equal(parsed.volume, null);
  assert.equal(parsed.peTtm, -12.3);
  assert.equal(parsed.totalMarketCap, null);
});
