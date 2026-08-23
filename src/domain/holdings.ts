import type {
  Holding,
  HoldingCurrency,
  Quote,
} from './models';

export interface HoldingMetrics {
  currency: HoldingCurrency;
  quantity: number;
  averageCost: number;
  currentPrice: number;
  costValue: number;
  marketValue: number;
  profit: number;
  returnPercent: number;
}

export interface HoldingCurrencySummary {
  currency: HoldingCurrency;
  itemCount: number;
  pricedItemCount: number;
  costValue: number;
  marketValue: number;
  profit: number;
  returnPercent: number | null;
}

export function holdingCurrency(holding: Holding): HoldingCurrency {
  return holding.market === 'HK' ? 'HKD' : 'CNY';
}

export function calculateHoldingMetrics(
  holding: Holding,
  quote: Quote | undefined,
): HoldingMetrics | undefined {
  if (
    !quote ||
    quote.state === 'error' ||
    quote.symbol !== holding.symbol ||
    quote.market !== holding.market ||
    quote.price === null ||
    !Number.isFinite(quote.price) ||
    quote.price <= 0
  ) {
    return undefined;
  }
  const costValue = holding.quantity * holding.averageCost;
  const marketValue = holding.quantity * quote.price;
  const profit = marketValue - costValue;
  if (
    !Number.isFinite(costValue) ||
    !Number.isFinite(marketValue) ||
    !Number.isFinite(profit) ||
    costValue <= 0
  ) {
    return undefined;
  }
  return {
    currency: holdingCurrency(holding),
    quantity: holding.quantity,
    averageCost: holding.averageCost,
    currentPrice: quote.price,
    costValue,
    marketValue,
    profit,
    returnPercent: (profit / costValue) * 100,
  };
}

export function summarizeHoldingCurrency(
  currency: HoldingCurrency,
  holdings: readonly Holding[],
  quoteOf: (holding: Holding) => Quote | undefined,
): HoldingCurrencySummary {
  let pricedItemCount = 0;
  let costValue = 0;
  let marketValue = 0;
  let profit = 0;
  for (const holding of holdings) {
    const metrics = calculateHoldingMetrics(holding, quoteOf(holding));
    if (!metrics || metrics.currency !== currency) {
      continue;
    }
    pricedItemCount += 1;
    costValue += metrics.costValue;
    marketValue += metrics.marketValue;
    profit += metrics.profit;
  }
  return {
    currency,
    itemCount: holdings.length,
    pricedItemCount,
    costValue,
    marketValue,
    profit,
    returnPercent: costValue > 0 ? (profit / costValue) * 100 : null,
  };
}
