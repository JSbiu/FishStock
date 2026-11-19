import {
  formatCashAmount,
  formatCompactMarketValue,
  formatProfitCell,
  formatWeightPercent,
  summarizeHoldings,
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
export const UNTAGGED_HOLDING_NAME = '未标注';

export type HoldingSummaryMode = 'group' | 'tag';

export function normalizeHoldingSummaryMode(value: unknown): HoldingSummaryMode {
  return value === 'tag' ? 'tag' : 'group';
}

export interface HoldingGroupAssignment {
  name: string;
  order: number;
}

export interface HoldingGroupCatalog {
  byInstrument: ReadonlyMap<string, string>;
  orderByName: ReadonlyMap<string, number>;
}

export interface HoldingBreakdown {
  name: string;
  order: number;
  summary: HoldingSummary;
  /** 组内可用市值占总资产（含现金）的比例。 */
  weightPercent: number | null;
}

export interface SummarizeHoldingBreakdownsOptions {
  mode: HoldingSummaryMode;
  groupOf?(holding: Holding): HoldingGroupAssignment;
  now?: Date;
  hkdRate?: number | null;
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

export function holdingTagName(holding: Pick<Holding, 'tag'>): string {
  return holding.tag?.trim() || UNTAGGED_HOLDING_NAME;
}

function tagAssignmentOf(
  holdings: readonly Holding[],
): (holding: Holding) => HoldingGroupAssignment {
  const orderByName = new Map<string, number>();
  for (const holding of holdings) {
    const name = holdingTagName(holding);
    if (name !== UNTAGGED_HOLDING_NAME && !orderByName.has(name)) {
      orderByName.set(name, orderByName.size);
    }
  }
  if (holdings.some((holding) => holdingTagName(holding) === UNTAGGED_HOLDING_NAME)) {
    orderByName.set(UNTAGGED_HOLDING_NAME, orderByName.size);
  }
  return (holding) => {
    const name = holdingTagName(holding);
    return {
      name,
      order: orderByName.get(name) ?? Number.MAX_SAFE_INTEGER,
    };
  };
}

export function summarizeHoldingBreakdowns(
  holdings: readonly Holding[],
  quoteOf: (holding: Holding) => Quote | undefined,
  portfolio: Pick<PortfolioSummary, 'totalAssets'>,
  options: SummarizeHoldingBreakdownsOptions,
): HoldingBreakdown[] {
  const assignmentOf = options.mode === 'tag'
    ? tagAssignmentOf(holdings)
    : options.groupOf;
  const buckets = new Map<string, {
    name: string;
    order: number;
    holdings: Holding[];
  }>();
  for (const holding of holdings) {
    const assignment = assignmentOf?.(holding) ?? {
      name: DEFAULT_HOLDING_GROUP_NAME,
      order: 0,
    };
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
  return [...buckets.values()]
    .sort((left, right) =>
      left.order - right.order || left.name.localeCompare(right.name, 'zh-CN'))
    .map((bucket): HoldingBreakdown => {
      const summary = summarizeHoldings(
        bucket.holdings,
        quoteOf,
        options.now,
        options.hkdRate ?? null,
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
}

export function buildHoldingBreakdownDetail(
  breakdown: HoldingBreakdown,
): string {
  const summary = breakdown.summary;
  const segments = [`${summary.itemCount} 项`];
  if (summary.currency === null) {
    segments.push('未合并：未启用港币折算');
    return segments.join(' · ');
  }
  if (summary.pricedItemCount === 0) {
    segments.push('等待行情');
    return segments.join(' · ');
  }
  if (summary.pricedItemCount < summary.itemCount) {
    segments.push('部分行情');
  }
  if (summary.marketValue !== null) {
    segments.push(formatCompactMarketValue(summary.marketValue));
  }
  segments.push(breakdown.weightPercent === null
    ? '仓位 未合并'
    : `仓位 ${formatWeightPercent(breakdown.weightPercent)}`);
  if (summary.profit !== null) {
    segments.push(formatProfitCell(summary.profit, summary.returnPercent));
  }
  return segments.join(' · ');
}

export function buildHoldingCashBreakdownDetail(
  cash: CashBalance,
  weightPercent: number | null,
): string {
  return `${formatCashAmount(cash)} · ${
    weightPercent === null
      ? '仓位 未合并'
      : `仓位 ${formatWeightPercent(weightPercent)}`
  }`;
}
