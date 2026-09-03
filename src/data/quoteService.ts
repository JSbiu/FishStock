import type {
  MarketSession,
  NormalizedSymbol,
  Quote,
  RefreshResult,
} from '../domain/models';
import type { QuoteDataProvider } from './marketDataProvider';
import { parseMarketQuote } from './quoteParser';

const NO_DATA_TIMESTAMP = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知行情错误';
}

interface QuoteCacheEntry {
  quote: Quote;
  lastSuccessfulFetchAt?: number;
  lastRefreshError?: string;
}

type MarketSessionResolver = (
  symbol: NormalizedSymbol,
  now: Date,
) => MarketSession;

const ALWAYS_TRADING: MarketSessionResolver = () => ({
  phase: 'trading',
  label: '交易中',
  exact: true,
});

export class QuoteService {
  private readonly cache = new Map<string, QuoteCacheEntry>();
  private readonly fetchedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<RefreshResult>>();

  public constructor(
    private readonly provider: QuoteDataProvider,
    private readonly minFetchIntervalMs: number,
    private staleAfterMs: number,
    private readonly now: () => number = Date.now,
    private readonly sessionFor: MarketSessionResolver = ALWAYS_TRADING,
  ) {}

  public setStaleAfterMs(value: number): void {
    this.staleAfterMs = value;
  }

  public get(symbol: string): Quote | undefined {
    const entry = this.cache.get(symbol);
    return entry ? this.withFreshness(entry) : undefined;
  }

  public nextStateChangeAt(symbol: string, at = this.now()): number | undefined {
    const entry = this.cache.get(symbol);
    if (!entry || entry.lastSuccessfulFetchAt === undefined) {
      return undefined;
    }
    const quote = this.withFreshness(entry, at);
    if (quote.state !== 'live') {
      return undefined;
    }
    const session = this.sessionFor(
      { symbol: entry.quote.symbol, market: entry.quote.market },
      new Date(at),
    );
    if (session.phase !== 'trading') {
      return undefined;
    }
    const staleAt = entry.lastSuccessfulFetchAt + this.staleAfterMs + 1;
    return staleAt > at ? staleAt : undefined;
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
      const timestamp = this.fetchedAt.get(symbol);
      return timestamp !== undefined && now - timestamp < this.minFetchIntervalMs;
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
      const receivedAt = this.now();

      let missingCount = 0;
      for (const requested of symbols) {
        const quote = parsedBySymbol.get(requested.symbol);
        if (quote) {
          this.cache.set(requested.symbol, {
            quote,
            lastSuccessfulFetchAt: receivedAt,
          });
        } else {
          missingCount += 1;
          const cached = this.cache.get(requested.symbol);
          this.cache.set(
            requested.symbol,
            cached && cached.quote.price !== null
              ? { ...cached, lastRefreshError: '数据源未返回该标的' }
              : {
                  quote: this.unavailableQuote(requested, '数据源未返回该标的'),
                },
          );
        }
        this.fetchedAt.set(requested.symbol, receivedAt);
      }
      return {
        ...this.resultFor(symbols),
        ...(missingCount > 0
          ? { error: `数据源未返回 ${missingCount} 个标的` }
          : {}),
      };
    } catch (error: unknown) {
      const message = errorMessage(error);
      for (const symbol of symbols) {
        const cached = this.cache.get(symbol.symbol);
        this.cache.set(
          symbol.symbol,
          cached
            ? { ...cached, lastRefreshError: message }
            : { quote: this.unavailableQuote(symbol, `刷新失败：${message}`) },
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
          this.get(item.symbol) ?? this.withFreshness({
            quote: this.unavailableQuote(item, '尚无行情'),
          }),
        ]),
      ),
      providerName: this.provider.displayName,
    };
  }

  private withFreshness(entry: QuoteCacheEntry, now = this.now()): Quote {
    const quote = entry.quote;
    const session = this.sessionFor(
      { symbol: quote.symbol, market: quote.market },
      new Date(now),
    );
    const sessionFields = {
      sessionPhase: session.phase,
      sessionLabel: session.label,
      ...(session.tradingDate ? { tradingDate: session.tradingDate } : {}),
      ...(session.quoteValidSince !== undefined
        ? { quoteValidSince: session.quoteValidSince }
        : {}),
      ...(session.nextOpenAt ? { nextOpenAt: session.nextOpenAt } : {}),
      ...(entry.lastSuccessfulFetchAt !== undefined
        ? { lastSuccessfulFetchAt: entry.lastSuccessfulFetchAt }
        : {}),
      ...(entry.lastRefreshError
        ? { lastRefreshError: entry.lastRefreshError }
        : {}),
    };
    if (quote.state === 'error' || quote.price === null) {
      return { ...quote, ...sessionFields, state: 'error' };
    }

    const refreshFailure = entry.lastRefreshError
      ? `最近刷新失败：${entry.lastRefreshError}`
      : undefined;
    const fromFuture = quote.asOf - now > 5 * 60 * 1_000;
    if (fromFuture) {
      return {
        ...quote,
        ...sessionFields,
        state: 'stale',
        staleReason: 'future-timestamp',
        message: ['行情时间晚于本机时间', refreshFailure]
          .filter(Boolean)
          .join('；'),
      };
    }
    if (session.phase === 'unknown') {
      return {
        ...quote,
        ...sessionFields,
        state: 'stale',
        staleReason: 'session-uncovered',
        message: [session.label, refreshFailure].filter(Boolean).join('；'),
      };
    }

    if (session.phase === 'trading') {
      const refreshOverdue =
        entry.lastSuccessfulFetchAt === undefined ||
        now - entry.lastSuccessfulFetchAt > this.staleAfterMs;
      const quoteNotCurrent =
        session.quoteValidSince !== undefined &&
        quote.asOf < session.quoteValidSince;
      if (quoteNotCurrent || refreshOverdue) {
        const reason = quoteNotCurrent
          ? '未取得当前交易日行情'
          : '行情刷新超过过期阈值';
        const staleReason = quoteNotCurrent
          ? 'quote-not-current'
          : 'refresh-overdue';
        return {
          ...quote,
          ...sessionFields,
          state: 'stale',
          staleReason,
          message: [reason, refreshFailure].filter(Boolean).join('；'),
        };
      }
      return {
        ...quote,
        ...sessionFields,
        state: 'live',
        staleReason: undefined,
        message: refreshFailure,
      };
    }

    const quoteNotCurrent =
      session.quoteValidSince !== undefined &&
      quote.asOf < session.quoteValidSince;
    if (quoteNotCurrent) {
      return {
        ...quote,
        ...sessionFields,
        state: 'stale',
        staleReason: 'quote-not-current',
        message: [
          session.phase === 'break'
            ? '未取得当前交易日行情'
            : '未取得最近交易日行情',
          refreshFailure,
        ].filter(Boolean).join('；'),
      };
    }
    return {
      ...quote,
      ...sessionFields,
      state: 'closed',
      staleReason: undefined,
      message: refreshFailure,
    };
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
