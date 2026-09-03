import type {
  Holding,
  HoldingCurrency,
  Quote,
} from './models';
import { shanghaiDateString } from './tradingCalendar';

export interface HoldingMetrics {
  currency: HoldingCurrency;
  quantity: number;
  averageCost: number;
  currentPrice: number;
  costValue: number;
  marketValue: number;
  previousValue: number | null;
  profit: number;
  returnPercent: number;
  dayProfit: number | null;
  dayProfitPercent: number | null;
}

export interface HoldingCurrencySummary {
  currency: HoldingCurrency;
  itemCount: number;
  pricedItemCount: number;
  costValue: number;
  marketValue: number;
  profit: number;
  returnPercent: number | null;
  dayProfit: number | null;
  dayProfitPercent: number | null;
}

export function holdingCurrency(holding: Holding): HoldingCurrency {
  return holding.market === 'HK' ? 'HKD' : 'CNY';
}

/**
 * 取可用于计算当日盈亏的涨跌额，不属于当前交易日时返回 null。
 *
 * 判定只看行情自带时间戳 asOf，不看 quote.state：state 描述的是刷新是否及时，
 * 而当日盈亏关心的是这份数据属于哪个交易日。刷新失败时 state 会是 stale，但
 * 只要 asOf 仍落在本交易日的行情区间内，数据就依然属于当天，照常显示可以避免
 * 刷新抖动时数值在金额与占位符之间反复跳变；反过来，缓存跨了交易日时 asOf 会
 * 早于当日行情起点，此时必须退回 null，否则会把上一交易日的涨跌当成今日盈亏。
 */
export function holdingDayChange(
  quote: Quote | undefined,
  now: Date = new Date(),
): number | null {
  if (!quote || quote.change === null || !Number.isFinite(quote.change)) {
    return null;
  }
  if (quote.tradingDate !== shanghaiDateString(now)) {
    return null;
  }
  if (quote.quoteValidSince !== undefined && quote.asOf < quote.quoteValidSince) {
    return null;
  }
  return quote.change;
}

export function holdingDayProfit(
  holding: Holding,
  quote: Quote | undefined,
  now: Date = new Date(),
): number | null {
  const change = holdingDayChange(quote, now);
  return change === null ? null : change * holding.quantity;
}

export function calculateHoldingMetrics(
  holding: Holding,
  quote: Quote | undefined,
  now: Date = new Date(),
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
  const previousValue =
    quote.previousClose !== null && quote.previousClose > 0
      ? holding.quantity * quote.previousClose
      : null;
  const profit = marketValue - costValue;
  if (
    !Number.isFinite(costValue) ||
    !Number.isFinite(marketValue) ||
    !Number.isFinite(profit) ||
    costValue <= 0
  ) {
    return undefined;
  }
  const dayProfit = holdingDayProfit(holding, quote, now);
  return {
    currency: holdingCurrency(holding),
    quantity: holding.quantity,
    averageCost: holding.averageCost,
    currentPrice: quote.price,
    costValue,
    marketValue,
    previousValue,
    profit,
    returnPercent: (profit / costValue) * 100,
    dayProfit,
    dayProfitPercent:
      dayProfit !== null && previousValue !== null && previousValue > 0
        ? (dayProfit / previousValue) * 100
        : null,
  };
}

export function summarizeHoldingCurrency(
  currency: HoldingCurrency,
  holdings: readonly Holding[],
  quoteOf: (holding: Holding) => Quote | undefined,
  now: Date = new Date(),
): HoldingCurrencySummary {
  let pricedItemCount = 0;
  let costValue = 0;
  let marketValue = 0;
  let profit = 0;
  let dayProfit: number | null = null;
  let dayProfitBase = 0;
  for (const holding of holdings) {
    const metrics = calculateHoldingMetrics(holding, quoteOf(holding), now);
    if (!metrics || metrics.currency !== currency) {
      continue;
    }
    pricedItemCount += 1;
    costValue += metrics.costValue;
    marketValue += metrics.marketValue;
    profit += metrics.profit;
    // 当日盈亏的百分比只对“有当日行情”的条目求和，分子分母口径保持一致。
    if (metrics.dayProfit !== null && metrics.previousValue !== null) {
      dayProfit = (dayProfit ?? 0) + metrics.dayProfit;
      dayProfitBase += metrics.previousValue;
    }
  }
  return {
    currency,
    itemCount: holdings.length,
    pricedItemCount,
    costValue,
    marketValue,
    profit,
    returnPercent: costValue > 0 ? (profit / costValue) * 100 : null,
    dayProfit,
    dayProfitPercent:
      dayProfit !== null && dayProfitBase > 0 ? (dayProfit / dayProfitBase) * 100 : null,
  };
}
