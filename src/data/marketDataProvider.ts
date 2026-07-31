import type {
  Market,
  NormalizedSymbol,
  RawMarketQuote,
  StockSearchResult,
} from '../domain/models';

export interface MarketDataProvider {
  readonly id: string;
  readonly displayName: string;
  supports(market: Market): boolean;
  searchStocks(query: string, signal?: AbortSignal): Promise<StockSearchResult[]>;
  fetchQuotes(symbols: readonly NormalizedSymbol[], signal?: AbortSignal): Promise<RawMarketQuote[]>;
}
