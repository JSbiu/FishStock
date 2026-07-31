import type { NormalizedSymbol, Quote, RefreshResult } from '../domain/models';
import type { QuoteDataProvider } from './marketDataProvider';
import { parseMarketQuote } from './quoteParser';

const NO_DATA_TIMESTAMP = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知行情错误';
}
export class QuoteService {
  private readonly cache = new Map<string, Quote>();
  private readonly inFlight = new Map<string, Promise<RefreshResult>>();

  public constructor(
    private readonly provider: QuoteDataProvider,
    private readonly minFetchIntervalMs: number,
    private staleAfterMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  public setStaleAfterMs(value: number): void {
    this.staleAfterMs = value;
  }

  public get(symbol: string): Quote | undefined {
    const quote = this.cache.get(symbol);
    return quote ? this.withFreshness(quote) : undefined;
  }

  public async refresh(
    symbols: readonly NormalizedSymbol[],
    force = false,
  ): Promise<RefreshResult> {
    const unique = [...new Map(symbols.map((item) => [item.symbol, item])).values()].sort((a, b) =>
      a.symbol.localeCompare(b.symbol),
    );
    const key = unique.map((item) => item.symbol).join(',');
    const active = this.inFlight.get(key);
    if (active) {
      return active;
    }

    if (!force && unique.length > 0 && this.hasRecentCache(unique)) {
      return this.resultFor(unique);
    }

    const request = this.fetchAndCache(unique).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  private hasRecentCache(symbols: readonly NormalizedSymbol[]): boolean {
    const now = this.now();
    return symbols.every(({ symbol }) => {
      const quote = this.cache.get(symbol);
      return quote && now - quote.asOf < this.minFetchIntervalMs;
    });
  }

  private async fetchAndCache(symbols: readonly NormalizedSymbol[]): Promise<RefreshResult> {
    if (symbols.length === 0) {
      return this.resultFor(symbols);
    }

    try {
      const rawQuotes = await this.provider.fetchQuotes(symbols);
      const parsedBySymbol = new Map(
        rawQuotes.map((raw) => {
          const parsed = parseMarketQuote(raw);
          return [parsed.symbol, parsed] as const;
        }),
      );

      for (const requested of symbols) {
        const quote = parsedBySymbol.get(requested.symbol);
        if (quote) {
          this.cache.set(requested.symbol, quote);
        } else {
          this.cache.set(requested.symbol, this.unavailableQuote(requested, '数据源未返回该标的'));
        }
      }
      return this.resultFor(symbols);
    } catch (error: unknown) {
      const message = errorMessage(error);
      for (const symbol of symbols) {
        const cached = this.cache.get(symbol.symbol);
        this.cache.set(
          symbol.symbol,
          cached
            ? { ...cached, state: 'stale', message: `刷新失败：${message}` }
            : this.unavailableQuote(symbol, `刷新失败：${message}`),
        );
      }
      return { ...this.resultFor(symbols), error: message };
    }
  }

  private resultFor(symbols: readonly NormalizedSymbol[]): RefreshResult {
    return {
      quotes: new Map(
        symbols.map((item) => [
          item.symbol,
          this.get(item.symbol) ?? this.unavailableQuote(item, '尚无行情'),
        ]),
      ),
      providerName: this.provider.displayName,
    };
  }

  private withFreshness(quote: Quote): Quote {
    if (quote.state === 'live' && this.now() - quote.asOf > this.staleAfterMs) {
      return { ...quote, state: 'stale', message: '行情更新时间超过过期阈值' };
    }
    return quote;
  }

  private unavailableQuote(symbol: NormalizedSymbol, message: string): Quote {
    return {
      symbol: symbol.symbol,
      market: symbol.market,
      name: symbol.symbol,
      currency: symbol.market === 'HK' ? 'HKD' : 'CNY',
      price: null,
      previousClose: null,
      open: null,
      high: null,
      low: null,
      volume: null,
      volumeUnit: null,
      turnoverAmount: null,
      turnoverRate: null,
      peTtm: null,
      totalMarketCap: null,
      settlementPrice: null,
      openInterest: null,
      change: null,
      changePercent: null,
      asOf: NO_DATA_TIMESTAMP,
      state: 'error',
      message,
    };
  }
}
