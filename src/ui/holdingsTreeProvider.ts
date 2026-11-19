import {
  EventEmitter,
  MarkdownString,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  type TreeDataProvider,
} from 'vscode';
import type { ColorConvention } from '../config';
import {
  buildHoldingBreakdownDetail,
  buildHoldingCashBreakdownDetail,
  DEFAULT_HOLDING_GROUP_NAME,
  summarizeHoldingBreakdowns,
  type HoldingGroupAssignment,
  type HoldingBreakdown,
  type HoldingSummaryMode,
} from '../domain/holdingGroups';
import {
  buildHoldingDescriptionSegments,
  buildPortfolioSummarySegments,
  calculateHoldingMetrics,
  cashBalanceOf,
  DEFAULT_HOLDING_HKD_RATE,
  DEFAULT_HOLDING_DESCRIPTION_FIELD_ORDER,
  DEFAULT_HOLDING_DESCRIPTION_FIELDS,
  DEFAULT_HOLDING_SORT,
  formatCashAmount,
  formatCompactMarketValue,
  formatWeightPercent,
  holdingSortPaused,
  holdingCurrency,
  holdingIconKindOf,
  holdingWeightPercent,
  holdingTreeContextValue,
  sortHoldings,
  summarizePortfolio,
  type HoldingDescriptionField,
  type HoldingDescriptionFields,
  type HoldingIconKind,
  type HoldingSortState,
  type PortfolioSummary,
} from '../domain/holdings';
import type { CashBalance, Holding, Quote } from '../domain/models';
import type { HoldingsRepository } from '../storage/holdingsRepository';
import { HKD_DECORATION_SCHEME } from './holdingFileDecorationProvider';
import { quoteStaleLabel } from './quoteTooltip';
import { createHoldingTooltip } from './holdingTooltip';

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

function buildPendingHoldingDescription(
  holding: Holding,
  fields: HoldingDescriptionFields,
  suffix: string,
): string {
  const segments: string[] = [];
  if (fields.quantity) {
    segments.push(`${holding.quantity.toLocaleString('zh-CN')} ${holding.kind === 'fund' ? '份' : '股'}`);
  }
  segments.push(`等待行情${suffix}`);
  return segments.join(' · ');
}

export class HoldingNode {
  public readonly kind = 'holding';

  public constructor(
    public readonly holding: Holding,
    public readonly quote: Quote | undefined,
    public readonly weightPercent: number | null = null,
  ) {}
}

/** 现金不是证券，单独成行，不参与行情刷新、排序或调仓。 */
export class HoldingCashNode {
  public readonly kind = 'cash';

  public constructor(
    public readonly cash: CashBalance,
    public readonly summary: PortfolioSummary,
  ) {}
}

/** 全量汇总行，固定排在列表末尾。 */
export class HoldingSummaryNode {
  public readonly kind = 'summary';

  public constructor(
    public readonly summary: PortfolioSummary,
    public readonly breakdowns: readonly HoldingBreakdown[],
    public readonly cash: CashBalance,
    public readonly summaryMode: HoldingSummaryMode,
  ) {}
}

export type HoldingsTreeNode =
  | HoldingNode
  | HoldingCashNode
  | HoldingSummaryNode;

export interface HoldingsTreeProviderOptions {
  quoteOf(holding: Holding): Quote | undefined;
  providerNameOf(holding: Holding): string;
  /** 自选分组归属；省略时全部归入默认分组。 */
  groupOf?(holding: Holding): HoldingGroupAssignment;
}

export class HoldingsTreeProvider implements TreeDataProvider<HoldingsTreeNode> {
  private readonly emitter = new EventEmitter<HoldingsTreeNode | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(
    private readonly repository: HoldingsRepository,
    private readonly options: HoldingsTreeProviderOptions,
    private colorConvention: ColorConvention,
    private sort: HoldingSortState = DEFAULT_HOLDING_SORT,
    private fieldFlags: HoldingDescriptionFields = DEFAULT_HOLDING_DESCRIPTION_FIELDS,
    private hkdRate: number | null = null,
    private fieldOrder: readonly HoldingDescriptionField[] =
      DEFAULT_HOLDING_DESCRIPTION_FIELD_ORDER,
    private summaryMode: HoldingSummaryMode = 'group',
  ) {}

  public setColorConvention(value: ColorConvention): void {
    this.colorConvention = value;
    this.refresh();
  }

  public setSort(sort: HoldingSortState): void {
    this.sort = sort;
    this.refresh();
  }

  public setFieldFlags(flags: HoldingDescriptionFields): void {
    this.fieldFlags = flags;
    this.refresh();
  }

  public setFieldOrder(order: readonly HoldingDescriptionField[]): void {
    this.fieldOrder = order;
    this.refresh();
  }

  public setHkdRate(rate: number | null): void {
    this.hkdRate = rate;
    this.refresh();
  }

  public setSummaryMode(mode: HoldingSummaryMode): void {
    this.summaryMode = mode;
    this.refresh();
  }

  public isSortPaused(sort: HoldingSortState = this.sort): boolean {
    const state = this.repository.getSnapshot();
    const summary = summarizePortfolio(
      state.holdings,
      cashBalanceOf(state),
      (holding) => this.options.quoteOf(holding),
      new Date(),
      this.hkdRate,
    );
    return holdingSortPaused(
      state.holdings,
      sort,
      this.hkdRate,
      summary.totalAssets,
    );
  }

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public getTreeItem(element: HoldingsTreeNode): TreeItem {
    if (element instanceof HoldingCashNode) {
      return this.cashItem(element.cash, element.summary);
    }
    if (element instanceof HoldingSummaryNode) {
      return this.summaryItem(element);
    }

    const holding = element.holding;
    const metrics = calculateHoldingMetrics(holding, element.quote);
    const item = new TreeItem(holding.name ?? element.quote?.name ?? holding.symbol);
    item.id = `holding:${holding.id}`;
    item.contextValue = holdingTreeContextValue(this.sort);
    item.description = metrics
      ? buildHoldingDescriptionSegments(holding, metrics, {
          fields: this.fieldFlags,
          fieldOrder: this.fieldOrder,
          hkdRate: this.hkdRate,
          weightPercent: element.weightPercent,
          suspended: element.quote?.suspended === true,
        }).join(' · ')
      : buildPendingHoldingDescription(holding, this.fieldFlags, stateSuffix(element.quote));
    // 合并展示后 A 股与港股混排，靠角标区分币种；停牌等状态仍走图标，两者不争位。
    if (holdingCurrency(holding) === 'HKD') {
      item.resourceUri = Uri.parse(`${HKD_DECORATION_SCHEME}:${holding.symbol}`);
    }
    item.tooltip = createHoldingTooltip(
      holding,
      element.quote,
      this.options.providerNameOf(holding),
      undefined,
      this.hkdRate,
    );
    item.iconPath = this.holdingIcon(
      holdingIconKindOf(metrics?.dayProfit, element.quote),
    );
    item.command = {
      command: 'fishStock.openHoldingQuote',
      title: '打开行情',
      arguments: [element],
    };
    return item;
  }

  public getChildren(element?: HoldingsTreeNode): HoldingsTreeNode[] {
    if (element) {
      return [];
    }
    const state = this.repository.getSnapshot();
    const holdings = state.holdings;
    const cash = cashBalanceOf(state);
    if (holdings.length === 0 && cash.amount <= 0) {
      return [];
    }
    const now = new Date();
    const quoteOf = (holding: Holding): Quote | undefined => this.options.quoteOf(holding);
    const summary = summarizePortfolio(
      holdings,
      cash,
      quoteOf,
      now,
      this.hkdRate,
    );
    const nodes: HoldingsTreeNode[] = sortHoldings(
      holdings,
      this.sort,
      quoteOf,
      now,
      this.hkdRate,
      summary.totalAssets,
    ).map((holding) => {
      const quote = quoteOf(holding);
      return new HoldingNode(
        holding,
        quote,
        holdingWeightPercent(holding, quote, summary, this.hkdRate, now),
      );
    });
    const breakdowns = summarizeHoldingBreakdowns(
      holdings,
      quoteOf,
      summary,
      {
        mode: this.summaryMode,
        groupOf: (holding) => this.options.groupOf?.(holding)
          ?? { name: DEFAULT_HOLDING_GROUP_NAME, order: 0 },
        now,
        hkdRate: this.hkdRate,
      },
    );
    if (cash.amount > 0) {
      nodes.push(new HoldingCashNode(cash, summary));
    }
    nodes.push(new HoldingSummaryNode(
      summary,
      breakdowns,
      cash,
      this.summaryMode,
    ));
    return nodes;
  }

  public getParent(): HoldingsTreeNode | undefined {
    // 持仓与总计都是扁平列表，没有父节点。
    return undefined;
  }

  private summaryItem(element: HoldingSummaryNode): TreeItem {
    const { summary } = element;
    const label = summary.currency === null ? '总计' : `总资产 (${summary.currency})`;
    const item = new TreeItem(label, TreeItemCollapsibleState.None);
    item.id = 'holding-summary';
    item.iconPath = new ThemeIcon('sum');
    // 汇总行没有可操作对象，单独给一个 contextValue 以排除右键菜单。
    item.contextValue = 'fishStock.holdingSummary';
    if (summary.currency === null) {
      item.description = buildPortfolioSummarySegments(summary, {
        fields: this.fieldFlags,
      }).join(' · ');
      if (this.isSortPaused()) {
        item.description += ` · ${
          this.sort.key === 'weight' ? '仓位排序' : '金额排序'
        }暂用默认顺序`;
      }
      item.description += ' · 管理页查看小计';
      item.tooltip = this.summaryTooltip(element);
      item.command = { command: 'fishStock.manageHoldings', title: '查看各币种小计' };
      return item;
    }
    if (summary.pricedItemCount === 0 && summary.itemCount > 0 && (summary.cashValue ?? 0) <= 0) {
      item.description = '等待行情';
    } else if (summary.pricedItemCount === 0 && summary.itemCount > 0) {
      item.description = `部分行情 · 总资产 ${formatCompactMarketValue(summary.totalAssets ?? 0)} · 仓位 ${formatWeightPercent(summary.investedPercent)}`;
    } else {
      const partial = summary.pricedItemCount < summary.itemCount ? '部分 · ' : '';
      item.description = `${partial}${buildPortfolioSummarySegments(summary, {
        fields: this.fieldFlags,
      }).join(' · ')}`;
    }
    if (summary.hkdRate !== null) {
      const defaultLabel = summary.hkdRate === DEFAULT_HOLDING_HKD_RATE ? '（默认）' : '';
      item.description += ` · 汇率 ${summary.hkdRate}${defaultLabel}`;
    }
    item.tooltip = this.summaryTooltip(element);
    return item;
  }

  private summaryTooltip(element: HoldingSummaryNode): MarkdownString {
    const { summary } = element;
    const tooltip = new MarkdownString();
    tooltip.supportThemeIcons = true;
    const modeLabel = element.summaryMode === 'tag' ? '标签' : '分组';
    tooltip.appendMarkdown(`$(pie-chart) **按${modeLabel}汇总**\n\n`);
    if (element.breakdowns.length === 0) {
      tooltip.appendText('暂无可汇总持仓。');
    } else {
      element.breakdowns.forEach((breakdown, index) => {
        if (index > 0) {
          tooltip.appendMarkdown('\n');
        }
        tooltip.appendMarkdown('- **');
        tooltip.appendText(breakdown.name);
        tooltip.appendMarkdown('** · ');
        tooltip.appendText(buildHoldingBreakdownDetail(breakdown));
      });
    }
    if (element.cash.amount > 0) {
      if (element.breakdowns.length > 0) {
        tooltip.appendMarkdown('\n');
      }
      tooltip.appendMarkdown('- **现金（未分组）** · ');
      tooltip.appendText(buildHoldingCashBreakdownDetail(
        element.cash,
        summary.cashPercent,
      ));
    }
    tooltip.appendMarkdown('\n\n---\n\n');
    if (summary.currency === null) {
      tooltip.appendText('未启用港币折算，混币金额与占比不合并。');
      if (this.isSortPaused()) {
        tooltip.appendText(`\n\n已保留所选${
          this.sort.key === 'weight' ? '仓位排序' : '金额排序'
        }及升降序，恢复有效汇率后自动继续应用。`);
      }
    } else if (summary.pricedItemCount === 0 && summary.itemCount > 0) {
      tooltip.appendText('当前持仓没有可用于计算的有效价格。');
    } else {
      tooltip.appendText(summary.hkdRate === null
        ? `按原币种 ${summary.currency} 计算总资产与仓位，仅计入有价格的持仓；现金不参与盈亏。`
        : `按 CNY 计算总资产与仓位，1 HKD = ${summary.hkdRate} CNY${
          summary.hkdRate === DEFAULT_HOLDING_HKD_RATE ? '（默认占位值）' : ''
        }；仅计入有价格的持仓，现金不参与盈亏。`);
    }
    tooltip.appendMarkdown('\n\n$(info) ');
    tooltip.appendText(element.summaryMode === 'tag'
      ? '标签由持仓管理页手动填写；未填写时归入「未标注」。'
      : '分组读取 Stock / Fund 自选；同名合并，未关注归入「默认」。');
    tooltip.appendMarkdown('\n\n$(settings-gear) ');
    tooltip.appendText('在命令面板切换按分组或按标签汇总。');
    return tooltip;
  }

  private cashItem(cash: CashBalance, summary: PortfolioSummary): TreeItem {
    const item = new TreeItem('现金', TreeItemCollapsibleState.None);
    item.id = 'holding-cash';
    item.iconPath = new ThemeIcon('credit-card');
    item.contextValue = 'fishStock.holdingCash';
    const weight = summary.cashPercent === null
      ? '未合并'
      : `占比 ${formatWeightPercent(summary.cashPercent)}`;
    item.description = `${formatCashAmount(cash)} · ${weight}`;
    const lines = [
      `现金余额 ${formatCashAmount(cash)}。`,
      '现金不参与浮动盈亏或当日盈亏，只计入总资产和仓位。',
    ];
    if (cash.currency === 'HKD' && summary.hkdRate !== null) {
      lines.push(
        `按 1 HKD = ${summary.hkdRate} CNY 折算为 ${
          formatCashAmount({ amount: cash.amount * summary.hkdRate, currency: 'CNY' })
        }。`,
      );
    }
    item.tooltip = lines.join('\n');
    item.command = { command: 'fishStock.editHoldingCash', title: '设置现金' };
    return item;
  }

  private holdingIcon(kind: HoldingIconKind): ThemeIcon {
    switch (kind) {
      case 'warning':
        return new ThemeIcon('warning');
      case 'suspended':
        return new ThemeIcon('debug-pause');
      case 'stale':
        return new ThemeIcon('history');
      case 'unavailable':
        return new ThemeIcon('circle-outline');
      case 'flat':
        return new ThemeIcon('dash');
      case 'up':
        return new ThemeIcon('arrow-up', new ThemeColor(this.changeColor(true)));
      case 'down':
        return new ThemeIcon('arrow-down', new ThemeColor(this.changeColor(false)));
    }
  }

  private changeColor(isUp: boolean): string {
    const up = this.colorConvention === 'china' ? 'charts.red' : 'charts.green';
    const down = this.colorConvention === 'china' ? 'charts.green' : 'charts.red';
    return isUp ? up : down;
  }
}
