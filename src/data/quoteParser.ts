import type { Quote, RawMarketQuote } from '../domain/models';
import { normalizeSymbol } from '../domain/symbol';

export class QuoteParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'QuoteParseError';
  }
}
function requiredNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new QuoteParseError(`${field} 必须是大于 0 的有限数字`);
  }
  return parsed;
}

function requiredTimestamp(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new QuoteParseError('asOf 不是有效时间');
  }
  return parsed;
}

export function parseMarketQuote(raw: RawMarketQuote): Quote {
  const normalized = normalizeSymbol(raw.symbol);
  if (normalized.market !== raw.market) {
    throw new QuoteParseError(`行情市场与代码不匹配：${raw.symbol}`);
  }

  const price = requiredNumber(raw.price, 'price');
  const previousClose = requiredNumber(raw.previousClose, 'previousClose');
  const change = price - previousClose;

  return {
    symbol: normalized.symbol,
    market: normalized.market,
    name: raw.name.trim() || normalized.symbol,
    currency: raw.currency.trim(),
    price,
    previousClose,
    change,
    changePercent: (change / previousClose) * 100,
    asOf: requiredTimestamp(raw.asOf),
    state: raw.marketState === 'closed' ? 'closed' : 'live',
  };
}
