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

const LAST_KNOWN_DATE = Object.values(holidaysData.markets)
  .flat()
  .reduce((latest, day) => (day > latest ? day : latest), '');

export function shanghaiDateString(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
}

function isWeekend(dateString: string): boolean {
  const weekday = new Date(`${dateString}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function isTradingDay(market: Market, now: Date): boolean {
  const calendarKey = CALENDAR_MARKET[market];
  const dateString = shanghaiDateString(now);
  if (isWeekend(dateString)) {
    return false;
  }
  if (dateString > LAST_KNOWN_DATE) {
    return true;
  }
  return !(HOLIDAYS[calendarKey] ?? EMPTY_HOLIDAYS).has(dateString);
}

export function shouldAutoRefresh(markets: readonly Market[], now: Date): boolean {
  return markets.some((market) => isTradingDay(market, now));
}
