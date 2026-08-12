import assert from 'node:assert/strict';
import test from 'node:test';
import {
  futuresSessionRule,
  isSupportedFuturesSymbol,
  supportedFuturesProductCount,
} from '../domain/futuresSessions';

test('maps default futures to their product-specific night sessions', () => {
  assert.deepEqual(futuresSessionRule('AU0.CNF'), {
    venue: '上海期货交易所',
    nightEndMinutes: 150,
  });
  assert.deepEqual(futuresSessionRule('AG2608.CNF'), {
    venue: '上海期货交易所',
    nightEndMinutes: 150,
  });
  for (const symbol of ['CU0.CNF', 'AL0.CNF', 'SN0.CNF']) {
    assert.equal(futuresSessionRule(symbol)?.nightEndMinutes, 60);
  }
});

test('distinguishes night and day-only commodity products', () => {
  assert.equal(futuresSessionRule('M0.CNF')?.nightEndMinutes, 1_380);
  assert.equal(futuresSessionRule('LC0.CNF')?.nightEndMinutes, undefined);
  assert.equal(isSupportedFuturesSymbol('IF0.CNF'), false);
  assert.equal(isSupportedFuturesSymbol('XX0.CNF'), false);
  assert.equal(supportedFuturesProductCount(), 77);
});
