import type { Market, NormalizedSymbol } from './models';

export class SymbolFormatError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SymbolFormatError';
  }
}
const A_SHARE_MARKETS: Readonly<Record<string, Market>> = {
  SH: 'CN',
  SS: 'CN',
  SZ: 'CN',
  BJ: 'CN',
};

function normalizeAExchange(exchange: string): 'SH' | 'SZ' | 'BJ' {
  return exchange === 'SS' ? 'SH' : (exchange as 'SH' | 'SZ' | 'BJ');
}

function inferAExchange(code: string): 'SH' | 'SZ' | 'BJ' {
  if (/^92/.test(code)) {
    return 'BJ';
  }
  if (/^[569]/.test(code)) {
    return 'SH';
  }
  if (/^[0123]/.test(code)) {
    return 'SZ';
  }
  if (/^[48]/.test(code)) {
    return 'BJ';
  }
  throw new SymbolFormatError(`无法判断 A 股代码 ${code} 的交易所，请添加 .SH、.SZ 或 .BJ 后缀`);
}

export function isIndexSymbol(symbol: string): boolean {
  return /\.(?:SHI|SZI|HKI)$/i.test(symbol.trim());
}

export function isFuturesSymbol(symbol: string): boolean {
  return /\.CNF$/i.test(symbol.trim());
}

export function normalizeSymbol(input: string): NormalizedSymbol {
  const compact = input.trim().toUpperCase().replace(/\s+/g, '');
  if (!compact) {
    throw new SymbolFormatError('请输入代码');
  }

  const futures = compact.match(/^(?:NF_?)?([A-Z]{1,3}(?:0|\d{3,4}))(?:[.:_-]?CNF)?$/);
  if (futures) {
    return { symbol: `${futures[1]}.CNF`, market: 'CNF' };
  }

  const aIndexSuffix = compact.match(/^(\d{6})[.:_-]?(SHI|SZI)$/);
  if (aIndexSuffix) {
    return { symbol: `${aIndexSuffix[1]}.${aIndexSuffix[2]}`, market: 'CN' };
  }

  const aIndexPrefix = compact.match(/^(SHI|SZI)[.:_-]?(\d{6})$/);
  if (aIndexPrefix) {
    return { symbol: `${aIndexPrefix[2]}.${aIndexPrefix[1]}`, market: 'CN' };
  }

  const hkIndexSuffix = compact.match(/^([A-Z][A-Z0-9]{1,19})[.:_-]?HKI$/);
  if (hkIndexSuffix) {
    return { symbol: `${hkIndexSuffix[1]}.HKI`, market: 'HK' };
  }

  const hkIndexPrefix = compact.match(/^HKI[.:_-]?([A-Z][A-Z0-9]{1,19})$/);
  if (hkIndexPrefix) {
    return { symbol: `${hkIndexPrefix[1]}.HKI`, market: 'HK' };
  }

  const aSuffix = compact.match(/^(\d{6})[.:_-]?(SH|SS|SZ|BJ)$/);
  if (aSuffix) {
    const exchange = normalizeAExchange(aSuffix[2]);
    return { symbol: `${aSuffix[1]}.${exchange}`, market: A_SHARE_MARKETS[exchange] };
  }

  const aPrefix = compact.match(/^(SH|SS|SZ|BJ)[.:_-]?(\d{6})$/);
  if (aPrefix) {
    const exchange = normalizeAExchange(aPrefix[1]);
    return { symbol: `${aPrefix[2]}.${exchange}`, market: A_SHARE_MARKETS[exchange] };
  }

  const hkSuffix = compact.match(/^(\d{1,5})[.:_-]?HK$/);
  if (hkSuffix) {
    return { symbol: `${hkSuffix[1].padStart(5, '0')}.HK`, market: 'HK' };
  }

  const hkPrefix = compact.match(/^HK[.:_-]?(\d{1,5})$/);
  if (hkPrefix) {
    return { symbol: `${hkPrefix[1].padStart(5, '0')}.HK`, market: 'HK' };
  }

  if (/^\d{6}$/.test(compact)) {
    const exchange = inferAExchange(compact);
    return { symbol: `${compact}.${exchange}`, market: 'CN' };
  }

  if (/^\d{1,5}$/.test(compact)) {
    return { symbol: `${compact.padStart(5, '0')}.HK`, market: 'HK' };
  }

  const usSuffix = compact.match(/^([A-Z][A-Z0-9.-]{0,14})[.:_-]US$/);
  if (usSuffix) {
    return { symbol: `${usSuffix[1]}.US`, market: 'US' };
  }

  const usPrefix = compact.match(/^US[.:_-]?([A-Z][A-Z0-9.-]{0,14})$/);
  if (usPrefix) {
    return { symbol: `${usPrefix[1]}.US`, market: 'US' };
  }

  throw new SymbolFormatError(
    '代码格式无效；示例：600519、000001.SZ、00700.HK、000001.SHI、HSI.HKI',
  );
}
