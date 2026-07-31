import type { Market, NormalizedSymbol, RawMarketQuote } from '../domain/models';
import type { MarketDataProvider } from './marketDataProvider';

const TENCENT_QUOTE_URL = 'https://qt.gtimg.cn/q=';
const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 10_000;

interface ShanghaiTimeParts {
  year: number;
  month: number;
  day: number;
  weekday: string;
  minutes: number;
}
function shanghaiTimeParts(date: Date): ShanghaiTimeParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    weekday: value('weekday'),
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
  };
}

function isOpenSession(market: Market, minutes: number): boolean {
  if (market === 'CN') {
    return (minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900);
  }
  if (market === 'HK') {
    return (minutes >= 570 && minutes <= 720) || (minutes >= 780 && minutes <= 960);
  }
  return false;
}

export function parseTencentTimestamp(value: unknown): number {
  const text = String(value ?? '').trim();
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  const separated = text.match(
    /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  const match = compact ?? separated;
  if (!match) {
    throw new Error(`腾讯行情时间格式无效：${text || '空值'}`);
  }
  const [, year, month, day, hour, minute, second] = match;
  const timestamp = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`腾讯行情时间无效：${text}`);
  }
  return timestamp;
}

function marketState(market: Market, asOf: number, now: Date): 'open' | 'closed' {
  const current = shanghaiTimeParts(now);
  const quoteTime = shanghaiTimeParts(new Date(asOf));
  const sameTradingDate =
    current.year === quoteTime.year &&
    current.month === quoteTime.month &&
    current.day === quoteTime.day;
  const weekend = current.weekday === 'Sat' || current.weekday === 'Sun';
  return sameTradingDate && !weekend && isOpenSession(market, current.minutes)
    ? 'open'
    : 'closed';
}

export function toTencentSymbol(symbol: NormalizedSymbol): string {
  const [code, exchange] = symbol.symbol.split('.');
  if (symbol.market === 'HK' && exchange === 'HK') {
    return `r_hk${code.padStart(5, '0')}`;
  }
  if (symbol.market === 'CN' && exchange === 'SH') {
    return `sh${code}`;
  }
  if (symbol.market === 'CN' && exchange === 'SZ') {
    return `sz${code}`;
  }
  if (symbol.market === 'CN' && exchange === 'BJ') {
    return `bj${code}`;
  }
  throw new Error(`腾讯行情暂不支持 ${symbol.symbol}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTencentPayload(
  payload: unknown,
  requested: readonly NormalizedSymbol[],
  now: Date = new Date(),
): RawMarketQuote[] {
  if (!isRecord(payload)) {
    throw new Error('腾讯行情响应不是 JSON 对象');
  }

  const quotes: RawMarketQuote[] = [];
  for (const symbol of requested) {
    const row = payload[toTencentSymbol(symbol)];
    if (!Array.isArray(row) || row.length <= 30) {
      continue;
    }
    const price = Number(row[3]);
    const previousClose = Number(row[4]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(previousClose) || previousClose <= 0) {
      continue;
    }
    const asOf = parseTencentTimestamp(row[30]);
    quotes.push({
      symbol: symbol.symbol,
      market: symbol.market,
      name: String(row[1] ?? '').trim() || symbol.symbol,
      currency: symbol.market === 'HK' ? 'HKD' : 'CNY',
      price,
      previousClose,
      asOf,
      marketState: marketState(symbol.market, asOf, now),
    });
  }
  return quotes;
}

export class TencentDataProvider implements MarketDataProvider {
  public readonly id = 'tencent';
  public readonly displayName = '腾讯行情';

  public supports(market: Market): boolean {
    return market === 'CN' || market === 'HK';
  }

  public async fetchQuotes(
    symbols: readonly NormalizedSymbol[],
    signal?: AbortSignal,
  ): Promise<RawMarketQuote[]> {
    const quotes: RawMarketQuote[] = [];
    for (let index = 0; index < symbols.length; index += BATCH_SIZE) {
      const batch = symbols.slice(index, index + BATCH_SIZE);
      quotes.push(...(await this.fetchBatch(batch, signal)));
    }
    return quotes;
  }

  private async fetchBatch(
    symbols: readonly NormalizedSymbol[],
    signal?: AbortSignal,
  ): Promise<RawMarketQuote[]> {
    if (symbols.length === 0) {
      return [];
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
    try {
      const query = symbols.map(toTencentSymbol).join(',');
      const response = await fetch(`${TENCENT_QUOTE_URL}${query}&fmt=json`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FishStock/0.1',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`腾讯行情请求失败：HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      const text = new TextDecoder('gbk').decode(bytes);
      const payload: unknown = JSON.parse(text);
      return parseTencentPayload(payload, symbols);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
