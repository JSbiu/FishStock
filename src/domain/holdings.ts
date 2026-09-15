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
  // 停牌当日没有成交，昨收与最新价相同，算出来的"0"会被误读成"今天不涨不跌"。
  if (quote.suspended === true) {
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

/**
 * Holdings Tree View 描述行的字段开关。详情始终在悬浮面板与编辑器管理器里，
 * Tree View 只挑用户关心的几项——避免一行塞五个数据点。
 */
export interface HoldingDescriptionFields {
  quantity: boolean;
  marketValue: boolean;
  /** 浮动盈亏金额（百分比合并在括号里，不需要单独勾选收益率）。 */
  profit: boolean;
  /** 当日盈亏金额（百分比合并在括号里）。 */
  dayProfit: boolean;
}

export const DEFAULT_HOLDING_DESCRIPTION_FIELDS: HoldingDescriptionFields = {
  quantity: true,
  marketValue: true,
  profit: true,
  dayProfit: true,
};

/**
 * 至少保留一个字段——否则 Tree View 的描述会是空的，不如强制保留市值作为兜底。
 * （调用方需要在写入配置前用此函数校验。）
 */
export function ensureAtLeastOneField(
  fields: HoldingDescriptionFields,
): HoldingDescriptionFields {
  if (fields.marketValue || fields.profit || fields.dayProfit || fields.quantity) {
    return fields;
  }
  return { ...fields, marketValue: true };
}

/**
 * Tree View 的展示规则放在领域层，UI 层只负责读配置和触发刷新——
 * 字段选择、字段顺序、缺值 fallback 都是展示的契约，独立于 VS Code Tree API，
 * 也能在单元测试里完整覆盖。
 *
 * 函数式拆分而不是拼成大字符串：每一段都是独立可测、可独立呈现的语义单元，
 * UI 层拿到数组后 `join(' · ')` 即可。
 */
/**
 * 港币折算人民币**只用于展示**：领域数据始终按标的原币种存储，汇率变动不会污染
 * 持久化数据，也不会让历史快照对不上。
 *
 * 百分比一律不折算——它是相对值（盈亏 / 成本、当日 / 昨收），汇率在分子分母里
 * 约掉了，折算只是白白引入误差。
 */
export function toDisplayAmount(
  value: number,
  currency: HoldingCurrency,
  rate: number | null,
): number {
  return currency === 'HKD' && rate !== null && rate > 0 ? value * rate : value;
}

export interface HoldingDescriptionOptions {
  fields: HoldingDescriptionFields;
  /** 港币折算人民币的汇率；null 或省略表示不折算。 */
  hkdRate?: number | null;
  /** 停牌：当日无成交，用「停牌」替代「今日—」。 */
  suspended?: boolean;
}

export function buildHoldingDescriptionSegments(
  holding: Holding,
  metrics: HoldingMetrics,
  options: HoldingDescriptionOptions,
): string[] {
  const { fields, hkdRate = null, suspended = false } = options;
  const display = (value: number): number =>
    toDisplayAmount(value, metrics.currency, hkdRate);
  const segments: string[] = [];
  if (fields.quantity) {
    segments.push(`${holding.quantity.toLocaleString('zh-CN')} ${holding.kind === 'fund' ? '份' : '股'}`);
  }
  if (fields.marketValue) {
    segments.push(formatCompactMarketValue(display(metrics.marketValue)));
  }
  if (fields.profit) {
    segments.push(formatProfitCell(display(metrics.profit), metrics.returnPercent));
  }
  if (fields.dayProfit) {
    segments.push(
      suspended
        ? '停牌'
        : formatDayCell(
          metrics.dayProfit === null ? null : display(metrics.dayProfit),
          metrics.dayProfitPercent,
        ),
    );
  }
  return segments;
}

export function buildCurrencySummarySegments(
  summary: HoldingCurrencySummary,
  options: HoldingDescriptionOptions,
): string[] {
  const { fields, hkdRate = null, suspended = false } = options;
  const display = (value: number): number =>
    toDisplayAmount(value, summary.currency, hkdRate);
  const segments: string[] = [];
  if (fields.marketValue) {
    segments.push(formatCompactMarketValue(display(summary.marketValue)));
  }
  if (fields.profit) {
    segments.push(formatProfitCell(display(summary.profit), summary.returnPercent));
  }
  if (fields.dayProfit) {
    segments.push(
      suspended
        ? '停牌'
        : formatDayCell(
          summary.dayProfit === null ? null : display(summary.dayProfit),
          summary.dayProfitPercent,
        ),
    );
  }
  return segments;
}

/** 市值用万 / 亿压缩，避免 Tree View 一行里出现一长串数字。 */
export function formatCompactMarketValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100_000_000) {
    return `${(value / 100_000_000).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}亿`;
  }
  if (abs >= 10_000) {
    return `${(value / 10_000).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}万`;
  }
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

/** 盈亏是要核对的金额，保持完整数字带千分位，压缩成“5万”会丢精度。 */
export function formatSignedAmount(value: number): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toLocaleString('zh-CN', {
    maximumFractionDigits: 0,
  })}`;
}

/**
 * 百分比**必须带正负号**。收益率本身有方向（赚 / 亏），抹掉符号后排序出来的
 * 顺序虽然正确，读者却看不出谁赚谁亏，只能回头去数金额的正负——等于把排序
 * 的意义又赔回去了。
 */
export function formatSignedPercent(value: number): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

export function formatProfitCell(value: number, percent: number | null): string {
  return percent === null
    ? formatSignedAmount(value)
    : `${formatSignedAmount(value)}(${formatSignedPercent(percent)})`;
}

export function formatDayCell(value: number | null, percent: number | null): string {
  return value === null ? '今日—' : `今日${formatProfitCell(value, percent)}`;
}

export type HoldingIconKind =
  /** 无行情或行情错误。 */
  | 'warning'
  /** 停牌：无成交，价格沿用停牌前值。 */
  | 'suspended'
  /** 刷新超时，行情可能已过期。 */
  | 'stale'
  /** 行情有效但不属于当日，无从判断当日方向。 */
  | 'unavailable'
  /** 当日持平。 */
  | 'flat'
  | 'up'
  | 'down';

/**
 * 箭头方向跟随**当日盈亏**而不是浮动盈亏：Tree View 的图标回答的是"今天怎么样"，
 * 而"总共赚了多少"已经由描述行里的浮动盈亏表达了。
 *
 * 数据不可靠时不给方向——`stale` 与 `error` 状态下当日盈亏可能来自过期行情，
 * 画一个向上箭头会误导读数。注意休市（`closed`）不受此限：收盘价是确定事实，
 * 收盘后的当日盈亏仍然可信，此时照常显示方向。
 */
export function holdingIconKindOf(
  dayProfit: number | null | undefined,
  quote: Quote | undefined,
): HoldingIconKind {
  if (!quote || quote.state === 'error') {
    return 'warning';
  }
  // 停牌优先于 stale：停牌是确定的事实，比"数据可能过期"更值得说出来。
  if (quote.suspended === true) {
    return 'suspended';
  }
  if (quote.state === 'stale') {
    return 'stale';
  }
  if (dayProfit === null || dayProfit === undefined) {
    return 'unavailable';
  }
  if (dayProfit === 0) {
    return 'flat';
  }
  return dayProfit > 0 ? 'up' : 'down';
}

export type HoldingSortKey =
  /** 用户在 Tree View 里手动排的顺序；从未调整过即等于添加顺序。 */
  | 'manual'
  /** 浮动盈亏收益率（相对成本）。 */
  | 'profitPercent'
  /** 浮动盈亏金额。 */
  | 'profitAmount'
  /** 当日盈亏百分比（相对昨收）。 */
  | 'dayPercent'
  /** 当日盈亏金额。 */
  | 'dayAmount';

export interface HoldingSortState {
  key: HoldingSortKey;
  desc: boolean;
}

export const DEFAULT_HOLDING_SORT: HoldingSortState = { key: 'manual', desc: true };

/** 排序维度的中文名，命令面板与诊断报告共用，避免两处各写一份。 */
export const HOLDING_SORT_LABELS: Readonly<Record<HoldingSortKey, string>> = {
  manual: '默认顺序',
  profitPercent: '浮动盈亏收益率',
  profitAmount: '浮动盈亏金额',
  dayPercent: '今日盈亏收益率',
  dayAmount: '今日盈亏金额',
};

export function holdingSortLabel(sort: HoldingSortState): string {
  return sort.key === 'manual'
    ? HOLDING_SORT_LABELS.manual
    : `${HOLDING_SORT_LABELS[sort.key]}${sort.desc ? '（从高到低）' : '（从低到高）'}`;
}

function sortValueOf(
  metrics: HoldingMetrics,
  key: Exclude<HoldingSortKey, 'manual'>,
): number | null {
  switch (key) {
    case 'profitPercent':
      return metrics.returnPercent;
    case 'profitAmount':
      return metrics.profit;
    case 'dayPercent':
      return metrics.dayProfitPercent;
    case 'dayAmount':
      return metrics.dayProfit;
  }
}

/**
 * 无有效数值的条目一律排末尾，与升降序无关——把"算不出来"混进"亏得最多"里会
 * 误导排序结果。
 *
 * `Array.prototype.sort` 自 ES2019 起保证稳定，因此同值的条目保持手动顺序：
 * 手动排序在排序模式下依然生效，作为同值时的 tie-break。
 */
export function sortHoldings(
  holdings: readonly Holding[],
  sort: HoldingSortState,
  quoteOf: (holding: Holding) => Quote | undefined,
  now: Date = new Date(),
): Holding[] {
  if (sort.key === 'manual') {
    return [...holdings];
  }
  const key = sort.key;
  const withValue = holdings.map((holding) => {
    const metrics = calculateHoldingMetrics(holding, quoteOf(holding), now);
    return { holding, value: metrics ? sortValueOf(metrics, key) : null };
  });
  const direction = sort.desc ? -1 : 1;
  return withValue
    .sort((left, right) => {
      if (left.value === null && right.value === null) {
        return 0;
      }
      if (left.value === null) {
        return 1;
      }
      if (right.value === null) {
        return -1;
      }
      return direction * (left.value - right.value);
    })
    .map((item) => item.holding);
}

/**
 * 只在**同一币种分组内**移动。Holdings Tree View 按币种分组，跨币种移动没有意义——
 * 那等于把条目挪进另一个分组，而分组由标的本身决定，不是用户能排的。
 *
 * 交换的是扁平数组里的两个绝对位置，因此其他币种的条目位置不受影响。
 */
export function moveHoldingWithinCurrency(
  holdings: readonly Holding[],
  holdingId: string,
  delta: -1 | 1,
): Holding[] {
  const target = holdings.find((item) => item.id === holdingId);
  if (!target) {
    return [...holdings];
  }
  const currency = holdingCurrency(target);
  const groupIndices: number[] = [];
  holdings.forEach((item, index) => {
    if (holdingCurrency(item) === currency) {
      groupIndices.push(index);
    }
  });
  const position = groupIndices.findIndex((index) => holdings[index].id === holdingId);
  const next = position + delta;
  if (position < 0 || next < 0 || next >= groupIndices.length) {
    return [...holdings];
  }
  const result = [...holdings];
  const from = groupIndices[position];
  const to = groupIndices[next];
  const moved = result[from];
  result[from] = result[to];
  result[to] = moved;
  return result;
}
