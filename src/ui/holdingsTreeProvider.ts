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
  buildCurrencySummarySegments,
  buildHoldingDescriptionSegments,
  calculateHoldingMetrics,
  DEFAULT_HOLDING_DESCRIPTION_FIELDS,
  DEFAULT_HOLDING_SORT,
  holdingCurrency,
  holdingIconKindOf,
  sortHoldings,
  summarizeHoldingCurrency,
  type HoldingDescriptionFields,
  type HoldingIconKind,
  type HoldingSortState,
} from '../domain/holdings';
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
        item.description = `${partial}${buildCurrencySummarySegments(summary, {
          fields: this.fieldFlags,
          hkdRate: this.hkdRate,
        }).join(' · ')}`;
      }
      return item;
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
    return sortHoldings(matching, this.sort, (holding) =>
      this.options.quoteOf(holding),
    );
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
