export type Market = 'CN' | 'HK' | 'US' | 'CNF';

export type InstrumentKind = 'stock' | 'index' | 'fund' | 'future';

export type HoldingInstrumentKind = 'stock' | 'fund';

export type HoldingCurrency = 'CNY' | 'HKD';

export type QuoteState = 'live' | 'closed' | 'stale' | 'error';

export type QuoteStaleReason =
  | 'refresh-overdue'
  | 'quote-not-current'
  | 'future-timestamp'
  | 'session-uncovered';

export type MarketSessionPhase = 'trading' | 'break' | 'closed' | 'unknown';

export type VolumeUnit = 'lot' | 'share';

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

export interface Holding {
  id: string;
  symbol: string;
  market: 'CN' | 'HK';
  kind: HoldingInstrumentKind;
  name?: string;
  quantity: number;
  averageCost: number;
}

export interface HoldingsState {
  version: 1;
  holdings: Holding[];
}

export interface NormalizedSymbol {
  symbol: string;
  market: Market;
}

export interface StockSearchResult extends NormalizedSymbol {
  kind: InstrumentKind;
  name: string;
  abbreviation?: string;
  venue?: string;
}

export type HoldingSearchResult = StockSearchResult & {
  kind: HoldingInstrumentKind;
  market: 'CN' | 'HK';
};

export interface RawMarketQuote {
  symbol: string;
  market: Market;
  name: string;
  currency: string;
  price: unknown;
  previousClose: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  volume?: unknown;
  volumeUnit?: VolumeUnit;
  turnoverAmount?: unknown;
  turnoverRate?: unknown;
  peTtm?: unknown;
  totalMarketCap?: unknown;
  settlementPrice?: unknown;
  openInterest?: unknown;
  venue?: string;
  asOf: unknown;
  suspended?: unknown;
}

export interface Quote {
  symbol: string;
  market: Market;
  name: string;
  currency: string;
  price: number | null;
  previousClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  volumeUnit: VolumeUnit | null;
  turnoverAmount: number | null;
  turnoverRate: number | null;
  peTtm: number | null;
  totalMarketCap: number | null;
  settlementPrice: number | null;
  openInterest: number | null;
  venue?: string;
  change: number | null;
  changePercent: number | null;
  asOf: number;
  state: QuoteState;
  /** 停牌：当日无成交，价格沿用停牌前值，因此不能据此计算当日盈亏。 */
  suspended?: boolean;
  staleReason?: QuoteStaleReason;
  sessionPhase?: MarketSessionPhase;
  sessionLabel?: string;
  tradingDate?: string;
  quoteValidSince?: number;
  nextOpenAt?: number;
  lastSuccessfulFetchAt?: number;
  lastRefreshError?: string;
  message?: string;
}

export interface MarketSession {
  phase: MarketSessionPhase;
  label: string;
  exact: boolean;
  tradingDate?: string;
  quoteValidSince?: number;
  nextOpenAt?: number;
  nextTransitionAt?: number;
  /** 最近一个已结束交易窗口的结束时刻；用于收盘后的宽限刷新。 */
  lastWindowEnd?: number;
}

export interface RefreshResult {
  quotes: ReadonlyMap<string, Quote>;
  providerName: string;
  error?: string;
}
