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
  DEFAULT_HOLDING_DESCRIPTION_FIELDS,
  DEFAULT_HOLDING_SORT,
  holdingCurrency,
  holdingIconKindOf,
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
    // 非默认顺序下换一个 contextValue，让「上移 / 下移」菜单项自动隐藏——
    // 那时手动顺序会被排序覆盖，摆出来只会让人点了没反应。
    item.contextValue = this.sort.key === 'manual'
      ? 'fishStock.holding'
      : 'fishStock.holdingSorted';
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
    const item = new TreeItem('总计', TreeItemCollapsibleState.None);
    item.id = 'holding-summary';
    item.iconPath = new ThemeIcon('sum');
    // 汇总行没有可操作对象，单独给一个 contextValue 以排除右键菜单。
    item.contextValue = 'fishStock.holdingSummary';
    if (summary.pricedItemCount === 0) {
      item.description = '等待行情';
    } else {
      const partial = summary.pricedItemCount < summary.itemCount ? '部分 · ' : '';
      item.description = `${partial}${buildSummarySegments(summary, {
        fields: this.fieldFlags,
      }).join(' · ')}`;
    }
    item.tooltip = '全部持仓合计。港币条目按当前配置的汇率折算为人民币后一并计入。';
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
