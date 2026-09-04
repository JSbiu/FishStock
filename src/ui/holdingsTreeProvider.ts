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
  holdingCurrency,
  holdingIconKindOf,
  summarizeHoldingCurrency,
  type HoldingDescriptionFields,
  type HoldingIconKind,
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
    private viewMode: ViewMode = 'default',
    private fieldFlags: HoldingDescriptionFields = DEFAULT_HOLDING_DESCRIPTION_FIELDS,
  ) {}

  public setColorConvention(value: ColorConvention): void {
    this.colorConvention = value;
    this.refresh();
  }

  public setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.refresh();
  }

  public setFieldFlags(flags: HoldingDescriptionFields): void {
    this.fieldFlags = flags;
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
        item.description = `${partial}${buildCurrencySummarySegments(summary, this.fieldFlags).join(' · ')}`;
      }
      return item;
    }

    const holding = element.holding;
    const metrics = calculateHoldingMetrics(holding, element.quote);
    const item = new TreeItem(holding.name ?? element.quote?.name ?? holding.symbol);
    item.id = `holding:${holding.id}`;
    item.contextValue = 'fishStock.holding';
    item.description = metrics
      ? buildHoldingDescriptionSegments(holding, metrics, this.fieldFlags).join(' · ')
      : buildPendingHoldingDescription(holding, this.fieldFlags, stateSuffix(element.quote));
    item.tooltip = createHoldingTooltip(
      holding,
      element.quote,
      this.options.providerNameOf(holding),
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
    return applyHoldingViewOptions(matching, this.viewMode, (holding) =>
      this.options.quoteOf(holding),
    );
  }

  private holdingIcon(kind: HoldingIconKind): ThemeIcon {
    switch (kind) {
      case 'warning':
        return new ThemeIcon('warning');
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
