import assert from 'node:assert/strict';
import test from 'node:test';
import type { MarketSession, NormalizedSymbol } from '../domain/models';
import {
  compareSessionSnapshots,
  marketSessionSnapshot,
} from '../services/marketSessionMonitor';

const first: NormalizedSymbol = { symbol: 'AU0.CNF', market: 'CNF' };
const second: NormalizedSymbol = { symbol: 'AL0.CNF', market: 'CNF' };

test('detects session opening and closing transitions independently', () => {
  const resolver = (symbol: NormalizedSymbol, now: Date): MarketSession => ({
    phase:
      symbol.symbol === first.symbol
        ? now.getTime() < 2_000 ? 'trading' : 'closed'
        : now.getTime() >= 2_000 ? 'trading' : 'closed',
    label: '测试时段',
    exact: true,
    nextTransitionAt: 2_000,
  });
  const before = marketSessionSnapshot([first, second], resolver, new Date(1_000));
  const after = marketSessionSnapshot([first, second], resolver, new Date(2_000));
  const transition = compareSessionSnapshots(before.open, after);
  assert.deepEqual(transition, { opened: [second], closed: [first] });
});
