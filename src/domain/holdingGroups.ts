import {
  formatCashAmount,
  formatCompactMarketValue,
  formatDayCell,
  formatProfitCell,
  formatWeightPercent,
  summarizeHoldings,
  type HoldingDescriptionFields,
  type HoldingSummary,
  type PortfolioSummary,
} from './holdings';
import type {
  CashBalance,
  Holding,
  Quote,
  WatchlistState,
} from './models';

export const DEFAULT_HOLDING_GROUP_NAME = '默认';

export interface HoldingGroupAssignment {
  name: string;
  order: number;
}

export interface HoldingGroupCatalog {
  byInstrument: ReadonlyMap<string, string>;
  orderByName: ReadonlyMap<string, number>;
}

export interface HoldingGroupBreakdown {
  name: string;
  order: number;
  summary: HoldingSummary;
  /** 组内可用市值占总资产（含现金）的比例。 */
  weightPercent: number | null;
}

export interface HoldingGroupsOverview {
  groups: HoldingGroupBreakdown[];
  cashWeightPercent: number | null;
  shouldShow: boolean;
}

function instrumentKey(
  holding: Pick<Holding, 'kind' | 'symbol'>,
): string {
  return `${holding.kind}:${holding.symbol}`;
}

/**
 * 持仓不单独保存分组。个股读取 Stock 自选分组，ETF 读取 Fund 自选分组；
 * 没被自选关注或找不到归属时使用「默认」。Stock/Fund 中的同名分组合并。
 */
export function buildHoldingGroupCatalog(
  stockWatchlist: WatchlistState,
  fundWatchlist: WatchlistState,
): HoldingGroupCatalog {
  const byInstrument = new Map<string, string>();
  const orderByName = new Map<string, number>();
  const collect = (
    state: WatchlistState,
    kind: Holding['kind'],
  ): void => {
    for (const group of state.groups) {
      if (!orderByName.has(group.name)) {
        orderByName.set(group.name, orderByName.size);
      }
      for (const stock of group.stocks) {
        byInstrument.set(`${kind}:${stock.symbol}`, group.name);
      }
    }
  };
  collect(stockWatchlist, 'stock');
  collect(fundWatchlist, 'fund');
  if (!orderByName.has(DEFAULT_HOLDING_GROUP_NAME)) {
    orderByName.set(DEFAULT_HOLDING_GROUP_NAME, orderByName.size);
  }
  return { byInstrument, orderByName };
}

export function holdingGroupAssignment(
  holding: Pick<Holding, 'kind' | 'symbol'>,
  catalog: HoldingGroupCatalog,
): HoldingGroupAssignment {
  const name = catalog.byInstrument.get(instrumentKey(holding))
    ?? DEFAULT_HOLDING_GROUP_NAME;
  return {
    name,
    order: catalog.orderByName.get(name)
      ?? catalog.orderByName.get(DEFAULT_HOLDING_GROUP_NAME)
      ?? Number.MAX_SAFE_INTEGER,
  };
}

export function summarizeHoldingGroups(
  holdings: readonly Holding[],
  cash: CashBalance,
  quoteOf: (holding: Holding) => Quote | undefined,
  groupOf: (holding: Holding) => HoldingGroupAssignment,
  portfolio: Pick<PortfolioSummary, 'totalAssets' | 'cashPercent'>,
  now: Date = new Date(),
  hkdRate: number | null = null,
): HoldingGroupsOverview {
  const buckets = new Map<string, {
    name: string;
    order: number;
    holdings: Holding[];
  }>();
  for (const holding of holdings) {
    const assignment = groupOf(holding);
    const bucket = buckets.get(assignment.name);
    if (bucket) {
      bucket.holdings.push(holding);
      bucket.order = Math.min(bucket.order, assignment.order);
    } else {
      buckets.set(assignment.name, {
        name: assignment.name,
        order: assignment.order,
        holdings: [holding],
      });
    }
  }
  const groups = [...buckets.values()]
    .sort((left, right) =>
      left.order - right.order || left.name.localeCompare(right.name, 'zh-CN'))
    .map((bucket): HoldingGroupBreakdown => {
      const summary = summarizeHoldings(
        bucket.holdings,
        quoteOf,
        now,
        hkdRate,
      );
      const weightPercent = portfolio.totalAssets !== null
        && portfolio.totalAssets > 0
        && summary.marketValue !== null
        ? (summary.marketValue / portfolio.totalAssets) * 100
        : null;
      return {
        name: bucket.name,
        order: bucket.order,
        summary,
        weightPercent,
      };
    });
  return {
    groups,
    cashWeightPercent: cash.amount > 0 ? portfolio.cashPercent : null,
    shouldShow: groups.length > 0 && (
      groups.length > 1
      || groups[0].name !== DEFAULT_HOLDING_GROUP_NAME
      || cash.amount > 0
    ),
  };
}

export function buildHoldingGroupDescriptionSegments(
  group: HoldingGroupBreakdown,
  fields: HoldingDescriptionFields,
): string[] {
  const summary = group.summary;
  const segments = [`${summary.itemCount} 项`];
  if (summary.currency === null) {
    segments.push('未合并：未启用港币折算');
    return segments;
  }
  if (summary.pricedItemCount === 0) {
    segments.push('等待行情');
    return segments;
  }
  if (summary.pricedItemCount < summary.itemCount) {
    segments.push('部分行情');
  }
  if (fields.marketValue && summary.marketValue !== null) {
    segments.push(formatCompactMarketValue(summary.marketValue));
  }
  if (fields.weight) {
    segments.push(group.weightPercent === null
      ? '仓位 未合并'
      : `仓位 ${formatWeightPercent(group.weightPercent)}`);
  }
  if (fields.profit && summary.profit !== null) {
    segments.push(formatProfitCell(summary.profit, summary.returnPercent));
  }
  if (fields.dayProfit) {
    segments.push(formatDayCell(summary.dayProfit, summary.dayProfitPercent));
  }
  return segments;
}

export function buildHoldingGroupCashDescription(
  cash: CashBalance,
  weightPercent: number | null,
): string {
  return `${formatCashAmount(cash)} · ${
    weightPercent === null
      ? '仓位 未合并'
      : `仓位 ${formatWeightPercent(weightPercent)}`
  }`;
}
