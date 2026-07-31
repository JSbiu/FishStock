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
    asOf: '2026-07-31T01:30:00.000Z',
    marketState: 'open',
    ...overrides,
  };
}

test('parses and calculates quote change from source values', () => {
  const parsed = parseMarketQuote(quote());
  assert.equal(parsed.symbol, '600519.SH');
  assert.equal(parsed.price, 102.5);
  assert.equal(parsed.change, 2.5);
  assert.equal(parsed.changePercent, 2.5);
  assert.equal(parsed.state, 'live');
});
test('maps an explicit closed market state', () => {
  assert.equal(parseMarketQuote(quote({ marketState: 'closed' })).state, 'closed');
});

test('rejects invalid numeric fields and market mismatches', () => {
  assert.throws(() => parseMarketQuote(quote({ price: 'NaN' })), QuoteParseError);
  assert.throws(() => parseMarketQuote(quote({ market: 'HK' })), QuoteParseError);
});
