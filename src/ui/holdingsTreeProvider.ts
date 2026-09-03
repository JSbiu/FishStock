import {
  EventEmitter,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  type TreeDataProvider,
} from 'vscode';
import type { ColorConvention } from '../config';
import {
  calculateHoldingMetrics,
  holdingCurrency,
  summarizeHoldingCurrency,
} from '../domain/holdings';
import { applyHoldingViewOptions, type ViewMode } from '../domain/viewOptions';
import type {
  Holding,
  HoldingCurrency,
  Quote,
} from '../domain/models';
import type { HoldingsRepository } from '../storage/holdingsRepository';
import { quoteStaleLabel } from './quoteTooltip';
import { createHoldingTooltip } from './holdingTooltip';

const CURRENCIES: readonly HoldingCurrency[] = ['CNY', 'HKD'];

function currencyLabel(currency: HoldingCurrency): string {
  return currency === 'CNY' ? '人民币持仓' : '港币持仓';
}

/** 市值用万 / 亿压缩，避免 Tree View 一行里出现一长串数字。 */
function formatCompactValue(value: number): string {
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
function formatSignedAmount(value: number): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toLocaleString('zh-CN', {
    maximumFractionDigits: 0,
  })}`;
}

// 百分比只表示幅度，方向由金额的正负号表达，避免同一格里出现两个符号。
function formatPercentMagnitude(value: number): string {
  return `${Math.abs(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

function formatProfitCell(value: number, percent: number | null): string {
  return percent === null
    ? formatSignedAmount(value)
    : `${formatSignedAmount(value)}(${formatPercentMagnitude(percent)})`;
}

function formatDayCell(value: number | null, percent: number | null): string {
  return value === null ? '今日—' : `今日${formatProfitCell(value, percent)}`;
}

function stateSuffix(quote: Quote | undefined): string {
  if (!quote || quote.state === 'error') {
    return ' · 暂不可用';
  }
  if (quote.state === 'stale') {
    return ` · ${quoteStaleLabel(quote)}`;
  }
  if (quote.state === 'closed') {
    return ` · ${quote.sessionLabel ?? '休市'}`;
  }
  return '';
}

export class HoldingCurrencyNode {
  public readonly kind = 'currency';

  public constructor(
    public readonly currency: HoldingCurrency,
    public readonly holdings: readonly Holding[],
  ) {}
}

export class HoldingNode {
  public readonly kind = 'holding';

  public constructor(
    public readonly holding: Holding,
    public readonly quote: Quote | undefined,
  ) {}
}

export type HoldingsTreeNode = HoldingCurrencyNode | HoldingNode;

export interface HoldingsTreeProviderOptions {
  quoteOf(holding: Holding): Quote | undefined;
  providerNameOf(holding: Holding): string;
}

export class HoldingsTreeProvider implements TreeDataProvider<HoldingsTreeNode> {
  private readonly emitter = new EventEmitter<HoldingsTreeNode | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(
    private readonly repository: HoldingsRepository,
    private readonly options: HoldingsTreeProviderOptions,
    private colorConvention: ColorConvention,
    private viewMode: ViewMode = 'default',
  ) {}

  public setColorConvention(value: ColorConvention): void {
    this.colorConvention = value;
    this.refresh();
  }

  public setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.refresh();
  }

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public getTreeItem(element: HoldingsTreeNode): TreeItem {
    if (element instanceof HoldingCurrencyNode) {
      const item = new TreeItem(
        currencyLabel(element.currency),
        TreeItemCollapsibleState.Expanded,
      );
      item.id = `holding-currency:${element.currency}`;
      item.iconPath = new ThemeIcon('wallet');
      const summary = summarizeHoldingCurrency(
        element.currency,
        element.holdings,
        (holding) => this.options.quoteOf(holding),
      );
      if (summary.pricedItemCount === 0) {
        item.description = '等待行情';
      } else {
        const partial = summary.pricedItemCount < summary.itemCount ? '部分 · ' : '';
        item.description = `${partial}${formatCompactValue(summary.marketValue)} · ${formatProfitCell(summary.profit, summary.returnPercent)} · ${formatDayCell(summary.dayProfit, summary.dayProfitPercent)}`;
      }
      return item;
    }

    const holding = element.holding;
    const metrics = calculateHoldingMetrics(holding, element.quote);
    const item = new TreeItem(holding.name ?? element.quote?.name ?? holding.symbol);
    item.id = `holding:${holding.id}`;
    item.contextValue = 'fishStock.holding';
    item.description = metrics
      ? `${holding.quantity.toLocaleString('zh-CN')} ${holding.kind === 'fund' ? '份' : '股'} · ${formatCompactValue(metrics.marketValue)} · ${formatProfitCell(metrics.profit, metrics.returnPercent)} · ${formatDayCell(metrics.dayProfit, metrics.dayProfitPercent)}`
      : `${holding.quantity.toLocaleString('zh-CN')} ${holding.kind === 'fund' ? '份' : '股'} · 等待行情${stateSuffix(element.quote)}`;
    item.tooltip = createHoldingTooltip(
      holding,
      element.quote,
      this.options.providerNameOf(holding),
    );
    item.iconPath = this.holdingIcon(metrics?.profit, element.quote);
    item.command = {
      command: 'fishStock.openHoldingQuote',
      title: '打开行情',
      arguments: [element],
    };
    return item;
  }

  public getChildren(element?: HoldingsTreeNode): HoldingsTreeNode[] {
    if (!element) {
      return CURRENCIES.flatMap((currency) => {
        const matching = this.visibleHoldings(currency);
        return matching.length > 0 ? [new HoldingCurrencyNode(currency, matching)] : [];
      });
    }
    if (element instanceof HoldingCurrencyNode) {
      return element.holdings.map((holding) =>
        new HoldingNode(holding, this.options.quoteOf(holding)));
    }
    return [];
  }

  public getParent(element: HoldingsTreeNode): HoldingCurrencyNode | undefined {
    if (!(element instanceof HoldingNode)) {
      return undefined;
    }
    const currency = holdingCurrency(element.holding);
    return new HoldingCurrencyNode(currency, this.visibleHoldings(currency));
  }

  private visibleHoldings(currency: HoldingCurrency): Holding[] {
    const matching = this.repository
      .getSnapshot()
      .holdings.filter((holding) => holdingCurrency(holding) === currency);
    return applyHoldingViewOptions(matching, this.viewMode, (holding) =>
      this.options.quoteOf(holding),
    );
  }

  private holdingIcon(
    profit: number | undefined,
    quote: Quote | undefined,
  ): ThemeIcon {
    if (!quote || quote.state === 'error' || profit === undefined) {
      return new ThemeIcon('warning');
    }
    if (quote.state === 'stale') {
      return new ThemeIcon('history');
    }
    if (quote.state === 'closed') {
      return new ThemeIcon('clock');
    }
    if (profit === 0) {
      return new ThemeIcon('dash');
    }
    const isUp = profit > 0;
    const color = this.colorConvention === 'china'
      ? isUp ? 'charts.red' : 'charts.green'
      : isUp ? 'charts.green' : 'charts.red';
    return new ThemeIcon(
      isUp ? 'arrow-up' : 'arrow-down',
      new ThemeColor(color),
    );
  }
}
