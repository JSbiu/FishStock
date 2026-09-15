import type {
  InstrumentKind,
  Market,
  NormalizedSymbol,
  RawMarketQuote,
  StockSearchResult,
} from '../domain/models';
import { isIndexSymbol, normalizeSymbol } from '../domain/symbol';
import { AccessDeniedBackoff } from './accessDeniedBackoff';
import type { BseSecurityDirectory } from './bseSecurityDirectory';
import type { MarketDataProvider } from './marketDataProvider';

const TENCENT_QUOTE_URL = 'https://qt.gtimg.cn/q=';
const TENCENT_SEARCH_URL = 'https://smartbox.gtimg.cn/s3/';
const BATCH_SIZE = 50;
const SEARCH_RESULT_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 10_000;

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

export function toTencentSymbol(symbol: NormalizedSymbol): string {
  const [code, exchange] = symbol.symbol.split('.');
  if (symbol.market === 'CN' && exchange === 'SHI') {
    return `sh${code}`;
  }
  if (symbol.market === 'CN' && exchange === 'SZI') {
    return `sz${code}`;
  }
  if (symbol.market === 'HK' && exchange === 'HKI') {
    return `r_hk${code}`;
  }
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

function decodeTencentSearchValue(payload: string): string {
  const match = payload.match(/^\s*v_hint="((?:\\.|[^"\\])*)";?\s*$/);
  if (!match) {
    throw new Error('腾讯证券搜索响应格式无效');
  }
  try {
    const decoded: unknown = JSON.parse(`"${match[1]}"`);
    if (typeof decoded !== 'string') {
      throw new Error('not a string');
    }
    return decoded;
  } catch {
    throw new Error('腾讯证券搜索内容无法解析');
  }
}

function parseTencentSearchPayloadFor(
  payload: string,
  target: 'stock' | 'fund',
): StockSearchResult[] {
  const value = decodeTencentSearchValue(payload);
  if (!value) {
    return [];
  }

  const results: StockSearchResult[] = [];
  const seen = new Set<string>();
  const seenIndexNames = new Set<string>();
  for (const entry of value.split('^')) {
    const [rawExchange, code, name, abbreviation, assetType] = entry.split('~');
    const exchange = rawExchange?.toLowerCase();
    const stockSuffix =
      (assetType === 'GP-A' || assetType?.startsWith('GP-A-')) &&
      ['sh', 'sz', 'bj'].includes(exchange)
        ? exchange.toUpperCase()
        : assetType === 'GP' && exchange === 'hk'
          ? 'HK'
          : undefined;
    const indexSuffix =
      assetType === 'ZS' && exchange === 'sh'
        ? 'SHI'
        : assetType === 'ZS' && exchange === 'sz'
          ? 'SZI'
          : assetType === 'ZS' && exchange === 'hk'
            ? 'HKI'
            : undefined;
    const fundSuffix =
      target === 'fund' && assetType === 'ETF' && ['sh', 'sz'].includes(exchange)
        ? exchange.toUpperCase()
        : undefined;
    const suffix = target === 'stock' ? stockSuffix ?? indexSuffix : fundSuffix;
    if (!suffix || !code || !name) {
      continue;
    }

    try {
      const normalized = normalizeSymbol(`${code}.${suffix}`);
      const cleanName = name.trim();
      const indexName = cleanName.toLocaleLowerCase('zh-CN');
      if (seen.has(normalized.symbol)) {
        continue;
      }
      if (indexSuffix && seenIndexNames.has(indexName)) {
        continue;
      }
      seen.add(normalized.symbol);
      if (indexSuffix) {
        seenIndexNames.add(indexName);
      }
      results.push({
        ...normalized,
        kind: target === 'fund' ? 'fund' : indexSuffix ? 'index' : 'stock',
        name: cleanName,
        ...(abbreviation?.trim() ? { abbreviation: abbreviation.trim() } : {}),
      });
      if (results.length >= SEARCH_RESULT_LIMIT) {
        break;
      }
    } catch {
      // Ignore supplier entries outside the selected Stock or Fund category.
    }
  }
  return results;
}

export function parseTencentSearchPayload(payload: string): StockSearchResult[] {
  return parseTencentSearchPayloadFor(payload, 'stock');
}

export function parseTencentFundSearchPayload(payload: string): StockSearchResult[] {
  return parseTencentSearchPayloadFor(payload, 'fund');
}

function normalizeCodeQuery(query: string): NormalizedSymbol | undefined {
  try {
    const normalized = normalizeSymbol(query);
    return normalized.market === 'CN' || normalized.market === 'HK' ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function instrumentKind(symbol: string): InstrumentKind {
  return isIndexSymbol(symbol) ? 'index' : 'stock';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scaledTencentNumber(value: unknown, scale: number): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * scale : undefined;
}

export function parseTencentPayload(
  payload: unknown,
  requested: readonly NormalizedSymbol[],
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
      open: row[5],
      high: row[33],
      low: row[34],
      volume: row[36],
      volumeUnit: symbol.market === 'CN' ? 'lot' : 'share',
      turnoverAmount:
        symbol.market === 'CN'
          ? scaledTencentNumber(row[37], 10_000)
          : row[37],
      turnoverRate: symbol.market === 'CN' ? row[38] : row[59],
      peTtm: row[39],
      totalMarketCap: scaledTencentNumber(row[45], 100_000_000),
      asOf,
      // 第 40 字段对停牌股返回 "S"，正常股票为空（2026-09-15 以东兴证券停牌实测确认）。
      suspended: String(row[40] ?? '').trim().toUpperCase() === 'S',
    });
  }
  return quotes;
}

export class TencentDataProvider implements MarketDataProvider {
  public readonly id = 'tencent';
  public readonly displayName = '腾讯行情';

  private readonly fetcher: typeof fetch;
  private readonly bseDirectory: BseSecurityDirectory | undefined;
  private readonly accessDeniedBackoff: AccessDeniedBackoff;

  public constructor(options: TencentDataProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.bseDirectory = options.bseDirectory;
    this.accessDeniedBackoff = new AccessDeniedBackoff(options.now ?? (() => new Date()));
  }

  public canAutomaticallyRefresh(): boolean {
    return this.accessDeniedBackoff.canRetry();
  }

  public getNextAutomaticRetryAt(): Date | undefined {
    return this.accessDeniedBackoff.getNextRetryAt();
  }

  public supports(market: Market): boolean {
    return market === 'CN' || market === 'HK';
  }

  public async searchStocks(
    query: string,
    signal?: AbortSignal,
  ): Promise<StockSearchResult[]> {
    const keyword = query.trim();
    if (!keyword) {
      return [];
    }

    const directoryRequest = this.bseDirectory
      ? this.bseDirectory.search(keyword, signal).catch(() => [])
      : Promise.resolve<StockSearchResult[]>([]);
    let tencentResults: StockSearchResult[] = [];
    let tencentError: unknown;
    try {
      tencentResults = await this.searchTencent(keyword, parseTencentSearchPayload, signal);
    } catch (error: unknown) {
      tencentError = error;
    }

    if (tencentResults.length > 0) {
      return tencentResults;
    }

    const directoryResults = await directoryRequest;
    const codeQuery = normalizeCodeQuery(keyword);
    if (codeQuery && directoryResults.length === 0) {
      try {
        const quote = (await this.fetchQuotes([codeQuery], signal))[0];
        if (quote) {
          return [
            {
              symbol: quote.symbol,
              market: quote.market,
              kind: instrumentKind(quote.symbol),
              name: quote.name,
            },
          ];
        }
      } catch (error: unknown) {
        tencentError ??= error;
      }
    }

    if (directoryResults.length > 0) {
      return directoryResults;
    }
    if (tencentError) {
      throw tencentError;
    }
    return [];
  }

  public async searchFunds(
    query: string,
    signal?: AbortSignal,
  ): Promise<StockSearchResult[]> {
    const keyword = query.trim();
    if (!keyword) {
      return [];
    }
    return this.searchTencent(keyword, parseTencentFundSearchPayload, signal);
  }

  public async fetchQuotes(
    symbols: readonly NormalizedSymbol[],
    signal?: AbortSignal,
  ): Promise<RawMarketQuote[]> {
    try {
      const quotes: RawMarketQuote[] = [];
      for (let index = 0; index < symbols.length; index += BATCH_SIZE) {
        const batch = symbols.slice(index, index + BATCH_SIZE);
        quotes.push(...(await this.fetchBatch(batch, signal)));
      }
      this.accessDeniedBackoff.reset();
      return quotes;
    } catch (error: unknown) {
      if (error instanceof TencentQuoteHttpError && error.status === 403) {
        const retryAt = this.accessDeniedBackoff.recordFailure();
        throw new Error(
          `${error.message}；自动刷新将在 ${retryAt.toISOString()} 后重试，手动刷新可立即探测`,
          { cause: error },
        );
      }
      throw error;
    }
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
      const response = await this.fetcher(`${TENCENT_QUOTE_URL}${query}&fmt=json`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FishStock',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new TencentQuoteHttpError(response.status);
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

  private async searchTencent(
    keyword: string,
    parse: (payload: string) => StockSearchResult[] = parseTencentSearchPayload,
    signal?: AbortSignal,
  ): Promise<StockSearchResult[]> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(
        `${TENCENT_SEARCH_URL}?q=${encodeURIComponent(keyword)}&t=all`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FishStock',
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`腾讯证券搜索失败：HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      const text = new TextDecoder('gbk').decode(bytes);
      return parse(text);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

export interface TencentDataProviderOptions {
  fetcher?: typeof fetch;
  bseDirectory?: BseSecurityDirectory;
  now?: () => Date;
}

class TencentQuoteHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`腾讯行情请求失败：HTTP ${status}`);
    this.name = 'TencentQuoteHttpError';
  }
}
