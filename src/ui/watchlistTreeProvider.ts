import {
  EventEmitter,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  TreeItemCollapsibleState,
  type TreeDataProvider,
} from 'vscode';
import type { ColorConvention } from '../config';
import type { Quote, Stock, WatchGroup } from '../domain/models';
import type { QuoteService } from '../data/quoteService';
import type { WatchlistRepository } from '../storage/watchlistRepository';
import { createQuoteTooltip, formatPercent, formatPrice } from './quoteTooltip';

export class GroupNode {
  public readonly kind = 'group';

  public constructor(public readonly group: WatchGroup) {}
}

export class StockNode {
  public readonly kind = 'stock';

  public constructor(
    public readonly groupId: string,
    public readonly stock: Stock,
    public readonly quote: Quote | undefined,
  ) {}
}

export type FishTreeNode = GroupNode | StockNode;

export interface WatchlistTreeOptions {
  groupContextValue?: string;
  itemContextValue?: string;
}

function quoteDescription(stock: Stock, quote: Quote | undefined): string {
  if (!quote || quote.price === null || quote.changePercent === null) {
    return `${stock.symbol} · 暂不可用`;
  }
  const suffix =
    quote.state === 'closed'
      ? ' · 休市'
      : quote.state === 'stale'
        ? ' · 数据过期'
        : quote.state === 'error'
          ? ' · 暂不可用'
          : '';
  return `${formatPrice(quote.price)}  ${formatPercent(quote.changePercent)}${suffix}`;
}

function quoteIcon(
  quote: Quote | undefined,
  convention: ColorConvention,
): ThemeIcon {
  if (!quote || quote.state === 'error') {
    return new ThemeIcon('warning');
  }
  if (quote.state === 'stale') {
    return new ThemeIcon('history');
  }
  if (quote.state === 'closed') {
    return new ThemeIcon('clock');
  }
  if (quote.change === null || quote.change === 0) {
    return new ThemeIcon('dash');
  }
  const isUp = quote.change > 0;
  const color =
    convention === 'china'
      ? isUp
        ? 'charts.red'
        : 'charts.green'
      : isUp
        ? 'charts.green'
        : 'charts.red';
  return new ThemeIcon(isUp ? 'arrow-up' : 'arrow-down', new ThemeColor(color));
}

export class WatchlistTreeProvider implements TreeDataProvider<FishTreeNode> {
  private readonly emitter = new EventEmitter<FishTreeNode | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(
    private readonly repository: WatchlistRepository,
    private readonly quotes: QuoteService,
    private colorConvention: ColorConvention,
    private readonly providerName: string,
    private readonly options: WatchlistTreeOptions = {},
  ) {}

  public setColorConvention(value: ColorConvention): void {
    this.colorConvention = value;
    this.refresh();
  }

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public getTreeItem(element: FishTreeNode): TreeItem {
    if (element instanceof GroupNode) {
      const item = new TreeItem(
        element.group.name,
        element.group.collapsed
          ? TreeItemCollapsibleState.Collapsed
          : TreeItemCollapsibleState.Expanded,
      );
      item.id = `group:${element.group.id}`;
      item.contextValue = this.options.groupContextValue ?? 'fishStock.group';
      item.description = `${element.group.stocks.length}`;
      item.iconPath = new ThemeIcon(element.group.collapsed ? 'folder' : 'folder-opened');
      return item;
    }

    const item = new TreeItem(element.stock.name ?? element.quote?.name ?? element.stock.symbol);
    item.id = `stock:${element.stock.id}`;
    item.contextValue = this.options.itemContextValue ?? 'fishStock.stock';
    item.description = quoteDescription(element.stock, element.quote);
    item.tooltip = createQuoteTooltip(element.stock, element.quote, this.providerName);
    item.iconPath = quoteIcon(element.quote, this.colorConvention);
    return item;
  }

  public getChildren(element?: FishTreeNode): FishTreeNode[] {
    const state = this.repository.getSnapshot();
    if (!element) {
      return state.groups.map((group) => new GroupNode(group));
    }
    if (element instanceof GroupNode) {
      const group = state.groups.find((item) => item.id === element.group.id);
      return (
        group?.stocks.map(
          (stock) => new StockNode(group.id, stock, this.quotes.get(stock.symbol)),
        ) ?? []
      );
    }
    return [];
  }
}
