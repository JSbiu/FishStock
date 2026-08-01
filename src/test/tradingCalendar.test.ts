import assert from 'node:assert/strict';
import test from 'node:test';
import { isTradingDay, shouldAutoRefresh } from '../domain/tradingCalendar';

function at(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

test('treats weekends as closed for every market', () => {
  assert.equal(isTradingDay('CN', at('2026-08-01')), false);
  assert.equal(isTradingDay('HK', at('2026-08-01')), false);
  assert.equal(isTradingDay('US', at('2026-08-01')), false);
  assert.equal(isTradingDay('CNF', at('2026-08-01')), false);
});

test('marks mainland exchange holidays as closed', () => {
  assert.equal(isTradingDay('CN', at('2026-10-01')), false);
  assert.equal(isTradingDay('CN', at('2026-02-16')), false);
  assert.equal(isTradingDay('CN', at('2026-04-06')), false);
  assert.equal(isTradingDay('CN', at('2025-10-08')), false);
});

test('marks Hong Kong exchange holidays as closed', () => {
  assert.equal(isTradingDay('HK', at('2026-02-17')), false);
  assert.equal(isTradingDay('HK', at('2026-12-25')), false);
  assert.equal(isTradingDay('HK', at('2026-10-19')), false);
});

test('keeps mainland trading days open on Hong Kong-only holidays', () => {
  assert.equal(isTradingDay('CN', at('2026-05-25')), true);
  assert.equal(isTradingDay('HK', at('2026-05-25')), false);
});

test('keeps Hong Kong trading days open on mainland-only holidays', () => {
  assert.equal(isTradingDay('CN', at('2025-10-08')), false);
  assert.equal(isTradingDay('HK', at('2025-10-08')), true);
});

test('maps futures to the mainland calendar', () => {
  assert.equal(isTradingDay('CNF', at('2026-10-01')), false);
  assert.equal(isTradingDay('CNF', at('2026-05-25')), true);
});

test('treats uncovered US dates as weekdays outside the calendar', () => {
  assert.equal(isTradingDay('US', at('2026-10-01')), true);
});

test('falls back to weekday checks after the last known holiday data', () => {
  assert.equal(isTradingDay('CN', at('2027-01-04')), true);
  assert.equal(isTradingDay('CN', at('2027-02-15')), true);
  assert.equal(isTradingDay('CN', at('2027-01-02')), false);
});

test('evaluates the trading date in Shanghai time', () => {
  const lateUtc = new Date('2026-09-30T18:00:00Z');
  assert.equal(isTradingDay('CN', lateUtc), false);
});

test('auto refresh runs when at least one watched market is trading', () => {
  assert.equal(shouldAutoRefresh(['HK'], at('2025-10-08')), true);
  assert.equal(shouldAutoRefresh(['CN'], at('2025-10-08')), false);
  assert.equal(shouldAutoRefresh(['CN', 'HK'], at('2026-05-25')), true);
  assert.equal(shouldAutoRefresh(['HK'], at('2026-05-25')), false);
  assert.equal(shouldAutoRefresh(['CNF'], at('2026-10-01')), false);
  assert.equal(shouldAutoRefresh([], at('2026-05-25')), false);
});
