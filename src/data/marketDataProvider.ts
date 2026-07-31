import type { Market, NormalizedSymbol, RawMarketQuote } from '../domain/models';

export interface MarketDataProvider {
  readonly id: string;
  readonly displayName: string;
  supports(market: Market): boolean;
  fetchQuotes(symbols: readonly NormalizedSymbol[], signal?: AbortSignal): Promise<RawMarketQuote[]>;
}
