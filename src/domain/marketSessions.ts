import type {
  Market,
  MarketSession,
  NormalizedSymbol,
} from './models';
import { futuresSessionRule } from './futuresSessions';
import {
  isHalfTradingDay,
  isTradingDate,
  isWeekend,
  shanghaiDateString,
} from './tradingCalendar';

interface SessionWindow {
  start: number;
  end: number;
  label: string;
  tradingDate: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const LOOK_AROUND_DAYS = 16;

function addDays(dateString: string, days: number): string {
  const timestamp = Date.parse(`${dateString}T00:00:00Z`) + days * DAY_MS;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function at(dateString: string, minutes: number): number {
  const dayOffset = Math.floor(minutes / 1_440);
  const minuteOfDay = ((minutes % 1_440) + 1_440) % 1_440;
  const hour = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const minute = String(minuteOfDay % 60).padStart(2, '0');
  return Date.parse(`${addDays(dateString, dayOffset)}T${hour}:${minute}:00+08:00`);
}

function localMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return value('hour') * 60 + value('minute');
}

function pushWindow(
  windows: SessionWindow[],
  dateString: string,
  startMinutes: number,
  endMinutes: number,
  label: string,
  tradingDate = dateString,
): void {
  windows.push({
    start: at(dateString, startMinutes),
    end: at(dateString, endMinutes),
    label,
    tradingDate,
  });
}

function expectedNextWeekday(dateString: string): string | undefined {
  const weekday = new Date(`${dateString}T00:00:00Z`).getUTCDay();
  if (weekday >= 1 && weekday <= 4) {
    return addDays(dateString, 1);
  }
  if (weekday === 5) {
    return addDays(dateString, 3);
  }
  return undefined;
}

function nextTradingDate(market: Market, dateString: string): string | undefined {
  for (let offset = 1; offset <= LOOK_AROUND_DAYS; offset += 1) {
    const candidate = addDays(dateString, offset);
    if (isTradingDate(market, candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function hasNightSessionOn(dateString: string): string | undefined {
  if (!isTradingDate('CNF', dateString)) {
    return undefined;
  }
  const expected = expectedNextWeekday(dateString);
  const next = nextTradingDate('CNF', dateString);
  return expected && next === expected ? next : undefined;
}

function stockWindows(market: Market, dateString: string): SessionWindow[] {
  if (!isTradingDate(market, dateString)) {
    return [];
  }
  const windows: SessionWindow[] = [];
  if (market === 'CN') {
    pushWindow(windows, dateString, 9 * 60 + 15, 9 * 60 + 25, '开盘集合竞价');
    pushWindow(windows, dateString, 9 * 60 + 30, 11 * 60 + 30, '上午交易');
    pushWindow(windows, dateString, 13 * 60, 14 * 60 + 57, '下午交易');
    pushWindow(windows, dateString, 14 * 60 + 57, 15 * 60, '收盘集合竞价');
  } else if (market === 'HK') {
    const closeMinutes = isHalfTradingDay(market, dateString)
      ? 12 * 60 + 10
      : 16 * 60 + 10;
    pushWindow(windows, dateString, 9 * 60, 9 * 60 + 30, '开市前时段');
    pushWindow(windows, dateString, 9 * 60 + 30, 12 * 60, '早市');
    if (!isHalfTradingDay(market, dateString)) {
      pushWindow(windows, dateString, 13 * 60, 16 * 60, '午市');
      pushWindow(windows, dateString, 16 * 60, closeMinutes, '收市竞价');
    } else {
      pushWindow(windows, dateString, 12 * 60, closeMinutes, '半日市收市竞价');
    }
  }
  return windows;
}

function futuresWindows(symbol: string, dateString: string): SessionWindow[] {
  const windows: SessionWindow[] = [];
  const rule = futuresSessionRule(symbol);
  if (rule?.nightEndMinutes !== undefined) {
    const tradingDate = hasNightSessionOn(dateString);
    if (tradingDate) {
      const end = rule.nightEndMinutes <= 150
        ? rule.nightEndMinutes + 1_440
        : rule.nightEndMinutes;
      pushWindow(windows, dateString, 21 * 60, end, '夜盘', tradingDate);
    }
  }
  if (isTradingDate('CNF', dateString)) {
    pushWindow(windows, dateString, 9 * 60, 10 * 60 + 15, '日盘第一节');
    pushWindow(windows, dateString, 10 * 60 + 30, 11 * 60 + 30, '日盘第二节');
    pushWindow(windows, dateString, 13 * 60 + 30, 15 * 60, '日盘第三节');
  }
  return windows;
}

function windowsAround(symbol: NormalizedSymbol, dateString: string): SessionWindow[] {
  const windows: SessionWindow[] = [];
  for (let offset = -LOOK_AROUND_DAYS; offset <= LOOK_AROUND_DAYS; offset += 1) {
    const candidate = addDays(dateString, offset);
    windows.push(
      ...(symbol.market === 'CNF'
        ? futuresWindows(symbol.symbol, candidate)
        : stockWindows(symbol.market, candidate)),
    );
  }
  return windows.sort((left, right) => left.start - right.start);
}

function quoteValidSince(
  windows: readonly SessionWindow[],
  tradingDate: string | undefined,
): number | undefined {
  return tradingDate === undefined
    ? undefined
    : windows.find((window) => window.tradingDate === tradingDate)?.start;
}

function breakLabel(symbol: NormalizedSymbol, now: Date): string {
  const dateString = shanghaiDateString(now);
  const minutes = localMinutes(now);
  if (symbol.market === 'CN' && isTradingDate('CN', dateString)) {
    if (minutes >= 9 * 60 + 25 && minutes < 9 * 60 + 30) {
      return '开盘间歇';
    }
    if (minutes >= 11 * 60 + 30 && minutes < 13 * 60) {
      return '午休';
    }
  }
  if (symbol.market === 'HK' && isTradingDate('HK', dateString)) {
    if (
      !isHalfTradingDay('HK', dateString) &&
      minutes >= 12 * 60 &&
      minutes < 13 * 60
    ) {
      return '午休';
    }
  }
  if (symbol.market === 'CNF' && isTradingDate('CNF', dateString)) {
    if (minutes >= 10 * 60 + 15 && minutes < 10 * 60 + 30) {
      return '盘间休息';
    }
    if (minutes >= 11 * 60 + 30 && minutes < 13 * 60 + 30) {
      return '午间休息';
    }
  }
  return '';
}

function couldBeUnknownNight(symbol: NormalizedSymbol, now: Date): boolean {
  if (symbol.market !== 'CNF' || futuresSessionRule(symbol.symbol)) {
    return false;
  }
  const dateString = shanghaiDateString(now);
  const minutes = localMinutes(now);
  if (minutes >= 21 * 60) {
    return hasNightSessionOn(dateString) !== undefined;
  }
  if (minutes < 2 * 60 + 30) {
    return hasNightSessionOn(addDays(dateString, -1)) !== undefined;
  }
  return false;
}

export function marketSessionFor(
  symbol: NormalizedSymbol,
  now: Date = new Date(),
): MarketSession {
  const timestamp = now.getTime();
  const dateString = shanghaiDateString(now);
  const windows = windowsAround(symbol, dateString);
  const current = windows.find((window) => timestamp >= window.start && timestamp < window.end);
  const previous = windows.filter((window) => window.end <= timestamp).at(-1);
  const next = windows.find((window) => window.start > timestamp);

  if (current) {
    return {
      phase: 'trading',
      label: current.label,
      exact: current.label !== '夜盘' || futuresSessionRule(symbol.symbol) !== undefined,
      tradingDate: current.tradingDate,
      quoteValidSince: quoteValidSince(windows, current.tradingDate),
      nextTransitionAt: current.end,
      ...(next ? { nextOpenAt: next.start } : {}),
    };
  }

  if (couldBeUnknownNight(symbol, now)) {
    return {
      phase: 'unknown',
      label: '交易时段未收录',
      exact: false,
      ...(next ? { nextOpenAt: next.start, nextTransitionAt: next.start } : {}),
    };
  }

  const label = breakLabel(symbol, now);
  const phase = label ? 'break' : 'closed';
  const closedLabel = isWeekend(dateString)
    ? '周末休市'
    : !isTradingDate(symbol.market, dateString)
      ? '节假日休市'
      : localMinutes(now) < 9 * 60
        ? '盘前'
        : '已收盘';
  const tradingDate = previous?.tradingDate;
  return {
    phase,
    label: label || closedLabel,
    exact: true,
    ...(tradingDate
      ? {
          tradingDate,
          quoteValidSince: quoteValidSince(windows, tradingDate),
        }
      : {}),
    ...(next ? { nextOpenAt: next.start, nextTransitionAt: next.start } : {}),
    ...(previous ? { lastWindowEnd: previous.end } : {}),
  };
}

/**
 * 收盘后的宽限刷新窗口。
 *
 * A 股最终收盘价要到 15:00:00 收盘集合竞价落定后才由行情源发布。若一到 15:00
 * 就停止刷新，手里留下的是 14:59:5x 的盘中价，收盘价、当日盈亏都会偏——2026-09-16
 * 实测宏桥控股在 15:00:00 取到的 asOf 是 14:59:51，即为此例。宽限期内继续按调度
 * 间隔刷新，让收盘价落定后的那一笔能取回来。同样适用于午休与盘间断点。
 */
const CLOSE_GRACE_MS = 60_000;

export function shouldAutoRefreshSymbol(
  symbol: NormalizedSymbol,
  now: Date,
): boolean {
  const session = marketSessionFor(symbol, now);
  if (session.phase === 'trading') {
    return true;
  }
  return session.lastWindowEnd !== undefined
    && now.getTime() - session.lastWindowEnd < CLOSE_GRACE_MS;
}
