export type Market = 'CN' | 'HK' | 'US';

export type QuoteState = 'live' | 'closed' | 'stale' | 'error';

export interface Stock {
  id: string;
  symbol: string;
  market: Market;
  name?: string;
}
export interface WatchGroup {
  id: string;
  name: string;
  collapsed: boolean;
  stocks: Stock[];
}

export interface WatchlistState {
  version: 1;
  groups: WatchGroup[];
}

export interface NormalizedSymbol {
  symbol: string;
  market: Market;
}

export interface StockSearchResult extends NormalizedSymbol {
  name: string;
  abbreviation?: string;
}

export interface RawMarketQuote {
  symbol: string;
  market: Market;
  name: string;
  currency: string;
  price: unknown;
  previousClose: unknown;
  asOf: unknown;
  marketState: 'open' | 'closed';
}

export interface Quote {
  symbol: string;
  market: Market;
  name: string;
  currency: string;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  asOf: number;
  state: QuoteState;
  message?: string;
}

export interface RefreshResult {
  quotes: ReadonlyMap<string, Quote>;
  providerName: string;
  error?: string;
}
