import {
  EventEmitter,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  type TreeDataProvider,
} from 'vscode';
import type { ColorConvention } from '../config';
import {
  buildHoldingDescriptionSegments,
  buildSummarySegments,
  calculateHoldingMetrics,
  DEFAULT_HOLDING_HKD_RATE,
  DEFAULT_HOLDING_DESCRIPTION_FIELDS,
  DEFAULT_HOLDING_SORT,
  holdingAmountSortPaused,
  holdingCurrency,
  holdingIconKindOf,
  holdingTreeContextValue,
  sortHoldings,
  summarizeHoldings,
  type HoldingDescriptionFields,
  type HoldingIconKind,
  type HoldingSortState,
  type HoldingSummary,
} from '../domain/holdings';
import type { Holding, Quote } from '../domain/models';
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
  ) {}
}

/** 全量汇总行，固定排在列表末尾。 */
export class HoldingSummaryNode {
  public readonly kind = 'summary';

  public constructor(public readonly summary: HoldingSummary) {}
}

export type HoldingsTreeNode = HoldingNode | HoldingSummaryNode;

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
    private sort: HoldingSortState = DEFAULT_HOLDING_SORT,
    private fieldFlags: HoldingDescriptionFields = DEFAULT_HOLDING_DESCRIPTION_FIELDS,
    private hkdRate: number | null = null,
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

  public setHkdRate(rate: number | null): void {
    this.hkdRate = rate;
    this.refresh();
  }

  public isAmountSortPaused(sort: HoldingSortState = this.sort): boolean {
    return holdingAmountSortPaused(this.repository.getSnapshot().holdings, sort, this.hkdRate);
  }

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public getTreeItem(element: HoldingsTreeNode): TreeItem {
    if (element instanceof HoldingSummaryNode) {
      return this.summaryItem(element.summary);
    }

    const holding = element.holding;
    const metrics = calculateHoldingMetrics(holding, element.quote);
    const item = new TreeItem(holding.name ?? element.quote?.name ?? holding.symbol);
    item.id = `holding:${holding.id}`;
    item.contextValue = holdingTreeContextValue(this.sort);
    item.description = metrics
      ? buildHoldingDescriptionSegments(holding, metrics, {
          fields: this.fieldFlags,
          hkdRate: this.hkdRate,
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
    const holdings = this.repository.getSnapshot().holdings;
    if (holdings.length === 0) {
      return [];
    }
    const now = new Date();
    const quoteOf = (holding: Holding): Quote | undefined => this.options.quoteOf(holding);
    const nodes: HoldingsTreeNode[] = sortHoldings(
      holdings,
      this.sort,
      quoteOf,
      now,
      this.hkdRate,
    ).map((holding) => new HoldingNode(holding, this.options.quoteOf(holding)));
    nodes.push(new HoldingSummaryNode(
      summarizeHoldings(holdings, quoteOf, now, this.hkdRate),
    ));
    return nodes;
  }

  public getParent(): HoldingsTreeNode | undefined {
    // 合并展示后是扁平列表，没有父节点。
    return undefined;
  }

  private summaryItem(summary: HoldingSummary): TreeItem {
    const label = summary.currency === null ? '总计' : `总计 (${summary.currency})`;
    const item = new TreeItem(label, TreeItemCollapsibleState.None);
    item.id = 'holding-summary';
    item.iconPath = new ThemeIcon('sum');
    // 汇总行没有可操作对象，单独给一个 contextValue 以排除右键菜单。
    item.contextValue = 'fishStock.holdingSummary';
    if (summary.currency === null) {
      item.description = buildSummarySegments(summary, { fields: this.fieldFlags }).join(' · ');
      if (this.isAmountSortPaused()) {
        item.description += ' · 金额排序暂用默认顺序';
      }
      item.description += ' · 管理页查看小计';
      item.tooltip = '点击打开持仓管理页，查看 CNY、HKD 小计。未启用港币折算，混币金额与比例不合并。';
      if (this.isAmountSortPaused()) {
        item.tooltip += '\n已保留所选金额排序及升降序，恢复有效汇率后自动继续应用。';
      }
      item.command = { command: 'fishStock.manageHoldings', title: '查看各币种小计' };
      return item;
    }
    if (summary.pricedItemCount === 0) {
      item.description = '等待行情';
    } else {
      const partial = summary.pricedItemCount < summary.itemCount ? '部分 · ' : '';
      item.description = `${partial}${buildSummarySegments(summary, {
        fields: this.fieldFlags,
      }).join(' · ')}`;
    }
    if (summary.hkdRate !== null) {
      const defaultLabel = summary.hkdRate === DEFAULT_HOLDING_HKD_RATE ? '（默认）' : '';
      item.description += ` · 汇率 ${summary.hkdRate}${defaultLabel}`;
    }
    item.tooltip = summary.hkdRate === null
      ? `按原币种 ${summary.currency} 合计，仅计入有价格的持仓。`
      : `按 CNY 合计，1 HKD = ${summary.hkdRate} CNY${
        summary.hkdRate === DEFAULT_HOLDING_HKD_RATE ? '（默认占位值）' : ''
      }；仅计入有价格的持仓。`;
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
