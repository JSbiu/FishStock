import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedSymbol } from '../domain/models';
import {
  marketSessionFor,
  shouldAutoRefreshSymbol,
} from '../domain/marketSessions';

const A_SHARE: NormalizedSymbol = { symbol: '600519.SH', market: 'CN' };
const HK_SHARE: NormalizedSymbol = { symbol: '00700.HK', market: 'HK' };
const AU: NormalizedSymbol = { symbol: 'AU0.CNF', market: 'CNF' };
const AL: NormalizedSymbol = { symbol: 'AL0.CNF', market: 'CNF' };
const RB: NormalizedSymbol = { symbol: 'RB0.CNF', market: 'CNF' };

function at(value: string): Date {
  return new Date(`${value}+08:00`);
}

test('models A-share auctions, breaks, lunch and close', () => {
  assert.deepEqual(
    [
      '2026-08-12T09:20:00',
      '2026-08-12T09:27:00',
      '2026-08-12T10:00:00',
      '2026-08-12T11:45:00',
      '2026-08-12T14:56:00',
      '2026-08-12T14:59:00',
      '2026-08-12T15:00:00',
    ].map((value) => {
      const session = marketSessionFor(A_SHARE, at(value));
      return [session.phase, session.label];
    }),
    [
      ['trading', '开盘集合竞价'],
      ['break', '开盘间歇'],
      ['trading', '上午交易'],
      ['break', '午休'],
      ['trading', '下午交易'],
      ['trading', '收盘集合竞价'],
      ['closed', '已收盘'],
    ],
  );
});

test('models Hong Kong full-day and closing-auction sessions', () => {
  assert.deepEqual(
    [
      '2026-08-12T09:10:00',
      '2026-08-12T11:59:00',
      '2026-08-12T12:30:00',
      '2026-08-12T16:05:00',
      '2026-08-12T16:10:00',
    ].map((value) => {
      const session = marketSessionFor(HK_SHARE, at(value));
      return [session.phase, session.label];
    }),
    [
      ['trading', '开市前时段'],
      ['trading', '早市'],
      ['break', '午休'],
      ['trading', '收市竞价'],
      ['closed', '已收盘'],
    ],
  );
});

test('closes Hong Kong half days after the noon auction', () => {
  assert.deepEqual(
    [
      '2026-12-24T11:59:00',
      '2026-12-24T12:05:00',
      '2026-12-24T12:10:00',
      '2026-12-24T13:00:00',
    ].map((value) => {
      const session = marketSessionFor(HK_SHARE, at(value));
      return [session.phase, session.label];
    }),
    [
      ['trading', '早市'],
      ['trading', '半日市收市竞价'],
      ['closed', '已收盘'],
      ['closed', '已收盘'],
    ],
  );
});

test('keeps exchange holidays independent', () => {
  assert.equal(marketSessionFor(A_SHARE, at('2026-05-25T10:00:00')).phase, 'trading');
  assert.equal(marketSessionFor(HK_SHARE, at('2026-05-25T10:00:00')).phase, 'closed');
  assert.equal(marketSessionFor(A_SHARE, at('2026-10-01T10:00:00')).label, '节假日休市');
});

test('models common futures day sections and breaks', () => {
  assert.deepEqual(
    [
      '2026-08-12T10:14:00',
      '2026-08-12T10:20:00',
      '2026-08-12T11:45:00',
      '2026-08-12T14:59:00',
      '2026-08-12T15:00:00',
    ].map((value) => {
      const session = marketSessionFor(AU, at(value));
      return [session.phase, session.label];
    }),
    [
      ['trading', '日盘第一节'],
      ['break', '盘间休息'],
      ['break', '午间休息'],
      ['trading', '日盘第三节'],
      ['closed', '已收盘'],
    ],
  );
});

test('uses product-specific futures night closing times', () => {
  assert.equal(marketSessionFor(AU, at('2026-08-13T02:29:00')).phase, 'trading');
  assert.equal(marketSessionFor(AU, at('2026-08-13T02:30:00')).phase, 'closed');
  assert.equal(marketSessionFor(AL, at('2026-08-13T00:59:00')).phase, 'trading');
  assert.equal(marketSessionFor(AL, at('2026-08-13T01:00:00')).phase, 'closed');
  assert.equal(marketSessionFor(RB, at('2026-08-12T22:59:00')).phase, 'trading');
  assert.equal(marketSessionFor(RB, at('2026-08-12T23:00:00')).phase, 'closed');
});

test('assigns Friday night and Saturday early hours to Monday trading', () => {
  const friday = marketSessionFor(AU, at('2026-08-14T21:30:00'));
  const saturday = marketSessionFor(AU, at('2026-08-15T00:30:00'));
  assert.deepEqual([friday.phase, friday.tradingDate], ['trading', '2026-08-17']);
  assert.deepEqual([saturday.phase, saturday.tradingDate], ['trading', '2026-08-17']);
  assert.equal(marketSessionFor(AU, at('2026-08-16T21:30:00')).phase, 'closed');
});

test('suppresses futures night trading before a public holiday', () => {
  assert.equal(marketSessionFor(AU, at('2026-09-30T21:30:00')).phase, 'closed');
  assert.equal(marketSessionFor(AU, at('2026-10-01T00:30:00')).phase, 'closed');
});

test('treats unknown futures night sessions conservatively', () => {
  const unknown: NormalizedSymbol = { symbol: 'XX0.CNF', market: 'CNF' };
  const day = marketSessionFor(unknown, at('2026-08-14T10:00:00'));
  const night = marketSessionFor(unknown, at('2026-08-14T21:30:00'));
  assert.deepEqual([day.phase, day.exact], ['trading', true]);
  assert.deepEqual([night.phase, night.label, night.exact], [
    'unknown',
    '交易时段未收录',
    false,
  ]);
});

test('auto refresh is limited to the symbol current session', () => {
  assert.equal(shouldAutoRefreshSymbol(A_SHARE, at('2026-08-12T11:45:00')), false);
  assert.equal(shouldAutoRefreshSymbol(HK_SHARE, at('2026-08-12T11:45:00')), true);
  assert.equal(shouldAutoRefreshSymbol(AU, at('2026-08-13T02:00:00')), true);
  assert.equal(shouldAutoRefreshSymbol(AL, at('2026-08-13T02:00:00')), false);
});
