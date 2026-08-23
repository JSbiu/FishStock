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
import type {
  Holding,
  HoldingCurrency,
  Quote,
} from '../domain/models';
import type { HoldingsRepository } from '../storage/holdingsRepository';
import { formatPercent, quoteStaleLabel } from './quoteTooltip';
import { createHoldingTooltip } from './holdingTooltip';

const CURRENCIES: readonly HoldingCurrency[] = ['CNY', 'HKD'];

function currencyLabel(currency: HoldingCurrency): string {
  return currency === 'CNY' ? '人民币持仓' : '港币持仓';
}

function formatAmount(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
  ) {}

  public setColorConvention(value: ColorConvention): void {
    this.colorConvention = value;
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
        item.description = `${summary.itemCount} 项 · 等待行情`;
      } else {
        const partial = summary.pricedItemCount < summary.itemCount ? '部分 ' : '';
        item.description = `${summary.itemCount} 项 · ${partial}${formatAmount(summary.profit)} ${element.currency}${summary.returnPercent === null ? '' : ` (${formatPercent(summary.returnPercent)})`}`;
      }
      return item;
    }

    const holding = element.holding;
    const metrics = calculateHoldingMetrics(holding, element.quote);
    const item = new TreeItem(holding.name ?? element.quote?.name ?? holding.symbol);
    item.id = `holding:${holding.id}`;
    item.contextValue = 'fishStock.holding';
    item.description = metrics
      ? `${holding.quantity.toLocaleString('zh-CN')} ${holding.kind === 'fund' ? '份' : '股'} · ${formatAmount(metrics.profit)} ${metrics.currency} (${formatPercent(metrics.returnPercent)})${stateSuffix(element.quote)}`
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
    const holdings = this.repository.getSnapshot().holdings;
    if (!element) {
      return CURRENCIES.flatMap((currency) => {
        const matching = holdings.filter((holding) => holdingCurrency(holding) === currency);
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
    const holdings = this.repository
      .getSnapshot()
      .holdings.filter((holding) => holdingCurrency(holding) === currency);
    return new HoldingCurrencyNode(currency, holdings);
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
