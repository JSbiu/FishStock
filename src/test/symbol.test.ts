import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSymbol, SymbolFormatError } from '../domain/symbol';

test('normalizes common A-share formats', () => {
  assert.deepEqual(normalizeSymbol('600519'), { symbol: '600519.SH', market: 'CN' });
  assert.deepEqual(normalizeSymbol('sz000001'), { symbol: '000001.SZ', market: 'CN' });
  assert.deepEqual(normalizeSymbol('000001.SZ'), { symbol: '000001.SZ', market: 'CN' });
  assert.deepEqual(normalizeSymbol('430047'), { symbol: '430047.BJ', market: 'CN' });
});
test('normalizes Hong Kong symbols to five digits', () => {
  assert.deepEqual(normalizeSymbol('700.hk'), { symbol: '00700.HK', market: 'HK' });
  assert.deepEqual(normalizeSymbol('hk:9988'), { symbol: '09988.HK', market: 'HK' });
});

test('keeps a future US extension point without enabling a provider', () => {
  assert.deepEqual(normalizeSymbol('AAPL.US'), { symbol: 'AAPL.US', market: 'US' });
});

test('rejects ambiguous or malformed symbols', () => {
  assert.throws(() => normalizeSymbol('ABC'), SymbolFormatError);
  assert.throws(() => normalizeSymbol(''), SymbolFormatError);
});
