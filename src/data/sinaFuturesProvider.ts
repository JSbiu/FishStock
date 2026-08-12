import type {
  NormalizedSymbol,
  RawMarketQuote,
  StockSearchResult,
} from '../domain/models';
import { isSupportedFuturesSymbol } from '../domain/futuresSessions';
import { isFuturesSymbol, normalizeSymbol } from '../domain/symbol';
import { AccessDeniedBackoff } from './accessDeniedBackoff';
import type { FuturesDataProvider } from './marketDataProvider';

const SINA_QUOTE_URL = 'https://hq.sinajs.cn/list=';
const SINA_SUGGEST_URL = 'https://suggest3.sinajs.cn/suggest/type=&key=';
const REQUEST_TIMEOUT_MS = 10_000;
const BATCH_SIZE = 50;
const CONTRACT_MONTHS = 24;
const SEARCH_MAIN_LIMIT = 5;

const MAIN_CONTRACT_NAMES: Readonly<Record<string, string>> = {
  AL0: '沪铝主连',
  AU0: '沪金主连',
};

const QUERY_ALIASES: Readonly<Record<string, string>> = {
  电解铝: '沪铝',
};

const FINANCIAL_FUTURES = new Set(['IC', 'IF', 'IH', 'IM', 'T', 'TF', 'TL', 'TS']);

const VENUE_NAMES: Readonly<Record<string, string>> = {
  沪: '上海期货交易所',
  连: '大连商品交易所',
  郑: '郑州商品交易所',
  广: '广州期货交易所',
  能源: '上海国际能源交易中心',
  上能源: '上海国际能源交易中心',
  上期能源: '上海国际能源交易中心',
  广期所: '广州期货交易所',
  中金所: '中国金融期货交易所',
};

export interface SinaFuturesProviderOptions {
  fetcher?: typeof fetch;
  now?: () => Date;
  decode?: (bytes: ArrayBuffer) => string;
}

class SinaFuturesHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`新浪期货行情请求失败：HTTP ${status}`);
    this.name = 'SinaFuturesHttpError';
  }
}

function toSinaSymbol(symbol: NormalizedSymbol): string {
  if (symbol.market !== 'CNF' || !isFuturesSymbol(symbol.symbol)) {
    throw new Error(`新浪期货行情暂不支持 ${symbol.symbol}`);
  }
  return `nf_${symbol.symbol.slice(0, -4)}`;
}

function shanghaiClock(date: Date): { date: string; seconds: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    seconds:
      Number(value('hour')) * 3_600 +
      Number(value('minute')) * 60 +
      Number(value('second')),
  };
}

function parseFuturesTimestamp(
  dateValue: string,
  timeValue: string,
  referenceNow: Date,
): number {
  const date = dateValue.trim();
  const compactTime = timeValue.trim().replaceAll(':', '');
  const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = compactTime.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!dateMatch || !timeMatch) {
    throw new Error(`新浪期货行情时间格式无效：${dateValue} ${timeValue}`);
  }
  let timestamp = Date.parse(
    `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}+08:00`,
  );
  if (!Number.isFinite(timestamp)) {
    throw new Error(`新浪期货行情时间无效：${dateValue} ${timeValue}`);
  }
  const sourceSeconds =
    Number(timeMatch[1]) * 3_600 +
    Number(timeMatch[2]) * 60 +
    Number(timeMatch[3]);
  const reference = shanghaiClock(referenceNow);
  const clockDifference = Math.abs(sourceSeconds - reference.seconds);
  const shortestClockDifference = Math.min(clockDifference, 86_400 - clockDifference);
  if (
    (Number(timeMatch[1]) >= 21 || Number(timeMatch[1]) < 3) &&
    timestamp - referenceNow.getTime() > 5 * 60 * 1_000 &&
    shortestClockDifference <= 10 * 60
  ) {
    timestamp = Date.parse(
      `${reference.date}T${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}+08:00`,
    );
  }
  return timestamp;
}

function mainContractName(code: string, sourceName: string): string {
  if (!code.endsWith('0')) {
    return sourceName;
  }
  const normalized = sourceName.replace(/连续$/, '主连');
  return MAIN_CONTRACT_NAMES[code] ??
    (normalized.endsWith('主连') ? normalized : `${normalized}主连`);
}

function venueName(value: string): string {
  const clean = value.trim();
  return VENUE_NAMES[clean] ?? (clean || '国内期货交易所');
}

export function parseSinaFuturesPayload(
  payload: string,
  requested: readonly NormalizedSymbol[],
  now: Date = new Date(),
): RawMarketQuote[] {
  const rows = new Map<string, string[]>();
  for (const match of payload.matchAll(/var\s+hq_str_nf_([A-Z0-9]+)="([^"]*)";/gi)) {
    rows.set(match[1].toUpperCase(), match[2].split(','));
  }

  const quotes: RawMarketQuote[] = [];
  for (const symbol of requested) {
    const normalized = normalizeSymbol(symbol.symbol);
    if (normalized.market !== 'CNF' || symbol.market !== 'CNF') {
      continue;
    }
    const code = normalized.symbol.slice(0, -4);
    const product = code.match(/^[A-Z]{1,3}/)?.[0];
    if (!product || FINANCIAL_FUTURES.has(product)) {
      continue;
    }
    const row = rows.get(code);
    if (!row || row.length < 18) {
      continue;
    }
    const price = Number(row[8]);
    const previousSettlement = Number(row[10]);
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(previousSettlement) ||
      previousSettlement <= 0
    ) {
      continue;
    }
    const asOf = parseFuturesTimestamp(row[17], row[1], now);
    quotes.push({
      symbol: normalized.symbol,
      market: 'CNF',
      name: mainContractName(code, row[0].trim() || code),
      currency: 'CNY',
      price,
      previousClose: previousSettlement,
      settlementPrice: previousSettlement,
      open: row[2],
      high: row[3],
      low: row[4],
      openInterest: row[13],
      volume: row[14],
      volumeUnit: 'lot',
      venue: venueName(row[15]),
      asOf,
    });
  }
  return quotes;
}

export function parseSinaFuturesSuggestions(payload: string): StockSearchResult[] {
  const match = payload.match(/^\s*var\s+suggestvalue="([\s\S]*)";?\s*$/);
  if (!match || !match[1]) {
    return [];
  }
  const results: StockSearchResult[] = [];
  const seen = new Set<string>();
  for (const entry of match[1].split(';')) {
    const fields = entry.split(',');
    if (fields[1] !== '87') {
      continue;
    }
    try {
      const normalized = normalizeSymbol(fields[3] ?? fields[2] ?? '');
      if (normalized.market !== 'CNF' || seen.has(normalized.symbol)) {
        continue;
      }
      seen.add(normalized.symbol);
      const code = normalized.symbol.slice(0, -4);
      const product = code.match(/^[A-Z]{1,3}/)?.[0];
      if (
        !product ||
        FINANCIAL_FUTURES.has(product) ||
        !isSupportedFuturesSymbol(normalized.symbol)
      ) {
        continue;
      }
      results.push({
        ...normalized,
        kind: 'future',
        name: mainContractName(code, fields[0]?.trim() || code),
      });
    } catch {
      // Ignore non-futures suggestions and malformed supplier rows.
    }
  }
  return results;
}

export function candidateFutureContracts(
  mainSymbol: string,
  now: Date = new Date(),
): NormalizedSymbol[] {
  const normalized = normalizeSymbol(mainSymbol);
  const mainCode = normalized.symbol.slice(0, -4);
  if (normalized.market !== 'CNF' || !mainCode.endsWith('0')) {
    return [];
  }
  const product = mainCode.slice(0, -1);
  const candidates: NormalizedSymbol[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < CONTRACT_MONTHS; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const fullYear = String(date.getFullYear()).slice(-2);
    const shortYear = String(date.getFullYear()).slice(-1);
    for (const code of [`${product}${fullYear}${month}`, `${product}${shortYear}${month}`]) {
      const candidate = normalizeSymbol(`${code}.CNF`);
      if (!seen.has(candidate.symbol)) {
        seen.add(candidate.symbol);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function cleanSearchQuery(query: string): string {
  const cleaned = query.trim().replace(/(?:主力合约|主连|连续|主力)$/u, '').trim();
  return QUERY_ALIASES[cleaned] ?? cleaned;
}

function resultFromQuote(quote: RawMarketQuote): StockSearchResult {
  return {
    symbol: quote.symbol,
    market: quote.market,
    kind: 'future',
    name: quote.name,
    ...(quote.venue ? { venue: quote.venue } : {}),
  };
}

function tradingDate(timestamp: unknown): string {
  const parsed = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp));
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(parsed)
    : '';
}

function activeContractQuotes(
  quotes: readonly RawMarketQuote[],
  mainSymbol: string,
): RawMarketQuote[] {
  const main = quotes.find((quote) => quote.symbol === mainSymbol);
  const currentTradingDate = main ? tradingDate(main.asOf) : '';
  return quotes.filter(
    (quote) =>
      quote.symbol.endsWith('0.CNF') ||
      (currentTradingDate !== '' && tradingDate(quote.asOf) === currentTradingDate),
  );
}

function mainSymbolFor(symbol: NormalizedSymbol): NormalizedSymbol {
  const code = symbol.symbol.slice(0, -4);
  const product = code.match(/^[A-Z]{1,3}/)?.[0];
  if (!product) {
    throw new Error(`期货合约代码无效：${symbol.symbol}`);
  }
  return { symbol: `${product}0.CNF`, market: 'CNF' };
}

export class SinaFuturesProvider implements FuturesDataProvider {
  public readonly id = 'sina-futures';
  public readonly displayName = '新浪期货行情';

  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly decode: (bytes: ArrayBuffer) => string;
  private readonly accessDeniedBackoff: AccessDeniedBackoff;

  public constructor(options: SinaFuturesProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.decode =
      options.decode ?? ((bytes) => new TextDecoder('gb18030').decode(bytes));
    this.accessDeniedBackoff = new AccessDeniedBackoff(this.now);
  }

  public canAutomaticallyRefresh(): boolean {
    return this.accessDeniedBackoff.canRetry();
  }

  public getNextAutomaticRetryAt(): Date | undefined {
    return this.accessDeniedBackoff.getNextRetryAt();
  }

  public async searchFutures(
    query: string,
    signal?: AbortSignal,
  ): Promise<StockSearchResult[]> {
    const cleanQuery = cleanSearchQuery(query);
    if (!cleanQuery) {
      return [];
    }

    const direct = this.normalizeDirectQuery(cleanQuery);
    if (direct) {
      if (!isSupportedFuturesSymbol(direct.symbol)) {
        return [];
      }
      const isMain = direct.symbol.endsWith('0.CNF');
      const main = isMain ? direct : mainSymbolFor(direct);
      const requested = isMain
        ? [direct, ...candidateFutureContracts(direct.symbol, this.now())]
        : [main, direct];
      const quotes = activeContractQuotes(await this.fetchQuotes(requested, signal), main.symbol);
      return quotes
        .filter((quote) => isMain || quote.symbol === direct.symbol)
        .map(resultFromQuote);
    }

    const payload = await this.fetchText(
      `${SINA_SUGGEST_URL}${encodeURIComponent(cleanQuery)}`,
      signal,
    );
    const mainResults = parseSinaFuturesSuggestions(payload).slice(0, SEARCH_MAIN_LIMIT);
    if (mainResults.length === 0) {
      return [];
    }

    const candidates = candidateFutureContracts(mainResults[0].symbol, this.now());
    const requested = [...mainResults, ...candidates];
    const quoteResults = activeContractQuotes(
      await this.fetchQuotes(requested, signal),
      mainResults[0].symbol,
    ).map(resultFromQuote);
    const quotedBySymbol = new Map(quoteResults.map((item) => [item.symbol, item]));
    const firstSymbol = mainResults[0].symbol;
    return [
      quotedBySymbol.get(firstSymbol) ?? mainResults[0],
      ...candidates.flatMap((candidate) => {
        const result = quotedBySymbol.get(candidate.symbol);
        return result ? [result] : [];
      }),
      ...mainResults.slice(1).map((item) => quotedBySymbol.get(item.symbol) ?? item),
    ];
  }

  public async fetchQuotes(
    symbols: readonly NormalizedSymbol[],
    signal?: AbortSignal,
  ): Promise<RawMarketQuote[]> {
    try {
      const quotes: RawMarketQuote[] = [];
      for (let index = 0; index < symbols.length; index += BATCH_SIZE) {
        const batch = symbols.slice(index, index + BATCH_SIZE);
        const query = batch.map(toSinaSymbol).join(',');
        const payload = await this.fetchText(`${SINA_QUOTE_URL}${query}`, signal);
        quotes.push(...parseSinaFuturesPayload(payload, batch, this.now()));
      }
      this.accessDeniedBackoff.reset();
      return quotes;
    } catch (error: unknown) {
      if (error instanceof SinaFuturesHttpError && error.status === 403) {
        const retryAt = this.accessDeniedBackoff.recordFailure();
        throw new Error(
          `${error.message}；自动刷新将在 ${retryAt.toISOString()} 后重试，手动刷新可立即探测`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private normalizeDirectQuery(query: string): NormalizedSymbol | undefined {
    try {
      const normalized = normalizeSymbol(query);
      return normalized.market === 'CNF' ? normalized : undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchText(url: string, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, {
        headers: {
          Referer: 'https://finance.sina.com.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FishStock',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new SinaFuturesHttpError(response.status);
      }
      return this.decode(await response.arrayBuffer());
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
