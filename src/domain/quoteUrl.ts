import { normalizeSymbol } from './symbol';

export function buildQuoteUrl(symbol: string): string | undefined {
  let normalized;
  try {
    normalized = normalizeSymbol(symbol);
  } catch {
    return undefined;
  }

  const [code, exchange] = normalized.symbol.split('.');
  if (normalized.market === 'CN') {
    if (exchange === 'SHI' || exchange === 'SZI') {
      return `https://quote.eastmoney.com/zs${code}.html`;
    }
    if (exchange === 'SH' || exchange === 'SZ' || exchange === 'BJ') {
      return `https://quote.eastmoney.com/${exchange.toLowerCase()}${code}.html`;
    }
    return undefined;
  }
  if (normalized.market === 'HK') {
    return exchange === 'HKI'
      ? `https://gu.qq.com/hk${code}`
      : `https://quote.eastmoney.com/hk/${code}.html`;
  }
  if (normalized.market === 'CNF') {
    return `https://finance.sina.com.cn/futures/quotes/${code}.shtml`;
  }
  return undefined;
}
