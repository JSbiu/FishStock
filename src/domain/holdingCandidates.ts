import type {
  HoldingInstrumentKind,
  HoldingSearchResult,
  WatchlistState,
} from './models';

// 持仓仅允许 A 股、港股和境内 ETF；指数（.SHI/.SZI）、期货（.CNF）与美股不满足后缀。
const HOLDING_SYMBOL_PATTERN = /\.(?:SH|SZ|BJ|HK)$/;

/**
 * 从股票自选与 ETF 自选快照中筛选可直接进入持仓草稿的条目。
 *
 * kind 按来源仓库推导：股票自选条目视为 stock，基金自选条目视为 fund。
 * 这样推导出的 kind 与行情缓存一致——股票自选行情由 stockQuotes 维护，
 * 基金自选行情由 fundQuotes 维护。基金自选只接受境内市场，避免产生
 * “基金持仓仅支持境内 ETF”无法通过存储校验的候选。
 *
 * 同一代码只在股票自选优先级下出现一次；无名称的条目回退为代码。
 */
export function holdingCandidatesFromWatchlists(
  stockWatchlist: WatchlistState,
  fundWatchlist: WatchlistState,
): HoldingSearchResult[] {
  const bySymbol = new Map<string, HoldingSearchResult>();
  const collect = (state: WatchlistState, kind: HoldingInstrumentKind): void => {
    for (const group of state.groups) {
      for (const item of group.stocks) {
        const marketEligible =
          item.market === 'CN' || (kind === 'stock' && item.market === 'HK');
        if (
          !marketEligible ||
          !HOLDING_SYMBOL_PATTERN.test(item.symbol) ||
          bySymbol.has(item.symbol)
        ) {
          continue;
        }
        const market: 'CN' | 'HK' = item.market === 'HK' ? 'HK' : 'CN';
        bySymbol.set(item.symbol, {
          symbol: item.symbol,
          market,
          kind,
          name: item.name ?? item.symbol,
        });
      }
    }
  };
  collect(stockWatchlist, 'stock');
  collect(fundWatchlist, 'fund');
  return [...bySymbol.values()];
}
