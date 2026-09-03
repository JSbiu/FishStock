import type { Holding, Quote, Stock } from './models';
import { calculateHoldingMetrics } from './holdings';

export type ViewMode = 'default' | 'gainDesc' | 'lossDesc' | 'upOnly' | 'downOnly';

export function applyViewOptions(
  stocks: readonly Stock[],
  mode: ViewMode,
  quoteOf: (symbol: string) => Quote | undefined,
): Stock[] {
  if (mode === 'default') {
    return [...stocks];
  }

  const withChange = stocks.map((stock) => ({
    stock,
    change: quoteOf(stock.symbol)?.changePercent ?? null,
  }));

  if (mode === 'upOnly' || mode === 'downOnly') {
    const keep = mode === 'upOnly' ? (change: number | null) => (change ?? 0) > 0
      : (change: number | null) => (change ?? 0) < 0;
    return withChange.filter((item) => keep(item.change)).map((item) => item.stock);
  }

  const direction = mode === 'gainDesc' ? -1 : 1;
  return [...withChange]
    .sort((left, right) => {
      if (left.change === null && right.change === null) {
        return 0;
      }
      if (left.change === null) {
        return 1;
      }
      if (right.change === null) {
        return -1;
      }
      return direction * (left.change - right.change);
    })
    .map((item) => item.stock);
}

/**
 * 持仓视图按收益率排序，而不是当日涨跌幅。
 *
 * 持仓的核心指标是相对成本的收益率；如果沿用自选的涨跌幅口径，"盈利优先"排出来
 * 的顺序会和当日盈亏列高度重合，容易被读成"今天涨得最多"。
 */
export function applyHoldingViewOptions(
  holdings: readonly Holding[],
  mode: ViewMode,
  quoteOf: (holding: Holding) => Quote | undefined,
): Holding[] {
  if (mode === 'default') {
    return [...holdings];
  }

  const withReturn = holdings.map((holding) => ({
    holding,
    returnPercent: calculateHoldingMetrics(holding, quoteOf(holding))?.returnPercent ?? null,
  }));

  if (mode === 'upOnly' || mode === 'downOnly') {
    const keep = mode === 'upOnly'
      ? (value: number | null) => (value ?? 0) > 0
      : (value: number | null) => (value ?? 0) < 0;
    return withReturn.filter((item) => keep(item.returnPercent)).map((item) => item.holding);
  }

  const direction = mode === 'gainDesc' ? -1 : 1;
  return [...withReturn]
    .sort((left, right) => {
      if (left.returnPercent === null && right.returnPercent === null) {
        return 0;
      }
      if (left.returnPercent === null) {
        return 1;
      }
      if (right.returnPercent === null) {
        return -1;
      }
      return direction * (left.returnPercent - right.returnPercent);
    })
    .map((item) => item.holding);
}
