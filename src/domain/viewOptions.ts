import type { Quote, Stock } from './models';

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

