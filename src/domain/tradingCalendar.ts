import type { Market } from './models';
import holidaysData from '../data/tradingHolidays.json';

const EMPTY_HOLIDAYS: ReadonlySet<string> = new Set();

const CALENDAR_MARKET: Readonly<Record<Market, Market>> = {
  CN: 'CN',
  HK: 'HK',
  US: 'US',
  CNF: 'CN',
};

const HOLIDAYS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(holidaysData.markets).map(([market, days]) => [
    market,
    new Set(days),
  ]),
);

const HALF_DAYS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(holidaysData.halfDays).map(([market, days]) => [
    market,
    new Set(days),
  ]),
);

const CALENDAR_RANGE: Readonly<Record<string, { first: string; last: string }>> =
  Object.fromEntries(
    Object.entries(holidaysData.coverage).map(([market, range]) => [
      market,
      { first: range.from, last: range.through },
    ]),
  );

export function shanghaiDateString(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
}

export function isWeekend(dateString: string): boolean {
  const weekday = new Date(`${dateString}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function isTradingDate(market: Market, dateString: string): boolean {
  const calendarKey = CALENDAR_MARKET[market];
  if (isWeekend(dateString)) {
    return false;
  }
  const range = CALENDAR_RANGE[calendarKey];
  if (!range || dateString < range.first || dateString > range.last) {
    return true;
  }
  return !(HOLIDAYS[calendarKey] ?? EMPTY_HOLIDAYS).has(dateString);
}

export function isTradingDay(market: Market, now: Date): boolean {
  return isTradingDate(market, shanghaiDateString(now));
}

export function isHalfTradingDay(market: Market, dateString: string): boolean {
  return (HALF_DAYS[CALENDAR_MARKET[market]] ?? EMPTY_HOLIDAYS).has(dateString);
}

export function hasCalendarCoverage(market: Market, dateString: string): boolean {
  const range = CALENDAR_RANGE[CALENDAR_MARKET[market]];
  return Boolean(range && dateString >= range.first && dateString <= range.last);
}

export function calendarCoverageEnd(market: Market): string | undefined {
  return CALENDAR_RANGE[CALENDAR_MARKET[market]]?.last || undefined;
}

export function shouldAutoRefresh(markets: readonly Market[], now: Date): boolean {
  return markets.some((market) => isTradingDay(market, now));
}
