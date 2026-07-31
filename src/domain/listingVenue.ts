import { isFuturesSymbol, isIndexSymbol, normalizeSymbol } from './symbol';

export function listingVenue(symbol: string): string | undefined {
  const normalized = normalizeSymbol(symbol);
  if (isFuturesSymbol(normalized.symbol) || isIndexSymbol(normalized.symbol)) {
    return undefined;
  }
  if (normalized.market === 'HK') {
    return '港交所';
  }

  const [code, exchange] = normalized.symbol.split('.');
  if (exchange === 'BJ') {
    return '北交所';
  }
  if (exchange === 'SH') {
    return /^(?:688|689)/.test(code) ? '科创板' : '上交所';
  }
  if (exchange === 'SZ') {
    return /^(?:300|301)/.test(code) ? '创业板' : '深交所';
  }
  return undefined;
}
