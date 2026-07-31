import type {
  Market,
  NormalizedSymbol,
  RawMarketQuote,
  StockSearchResult,
} from '../domain/models';

export interface QuoteDataProvider {
  readonly id: string;
  readonly displayName: string;
  fetchQuotes(symbols: readonly NormalizedSymbol[], signal?: AbortSignal): Promise<RawMarketQuote[]>;
}

export interface MarketDataProvider extends QuoteDataProvider {
  supports(market: Market): boolean;
  searchStocks(query: string, signal?: AbortSignal): Promise<StockSearchResult[]>;
}

export interface FuturesDataProvider extends QuoteDataProvider {
  searchFutures(query: string, signal?: AbortSignal): Promise<StockSearchResult[]>;
}
