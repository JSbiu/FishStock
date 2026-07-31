import {
  EventEmitter,
  MarkdownString,
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

function formatPrice(price: number): string {
  return price.toFixed(price < 10 ? 3 : 2);
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatDelta(value: number): string {
  const digits = Math.abs(value) < 10 ? 3 : 2;
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function formatOptionalPrice(value: number | null): string {
  return value === null ? '—' : formatPrice(value);
}

function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value);
  const scaled =
    absolute >= 1_000_000_000_000
      ? { value: value / 1_000_000_000_000, suffix: '万亿' }
      : absolute >= 100_000_000
        ? { value: value / 100_000_000, suffix: '亿' }
        : absolute >= 10_000
          ? { value: value / 10_000, suffix: '万' }
          : { value, suffix: '' };
  return `${scaled.value.toLocaleString('zh-CN', {
    minimumFractionDigits: scaled.suffix ? 2 : 0,
    maximumFractionDigits: 2,
  })}${scaled.suffix}`;
}

function formatVolume(quote: Quote): string {
  if (quote.volume === null || quote.volumeUnit === null) {
    return '—';
  }
  return `${formatCompactNumber(quote.volume)}${quote.volumeUnit === 'lot' ? '手' : '股'}`;
}

function formatMoney(value: number | null, currency: string): string {
  return value === null ? '—' : `${formatCompactNumber(value)} ${currency}`;
}

function formatRatio(value: number | null, suffix = ''): string {
  return value === null
    ? '—'
    : `${value.toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}${suffix}`;
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

function quoteTooltip(
  stock: Stock,
  quote: Quote | undefined,
  providerName: string,
): MarkdownString {
  const tooltip = new MarkdownString();
  tooltip.supportThemeIcons = true;
  if (!quote) {
    tooltip.appendText(`${stock.symbol}\n等待首次刷新`);
    return tooltip;
  }
  const timestamp = quote.asOf > 0 ? new Date(quote.asOf).toLocaleString('zh-CN') : '无';
  const stateText: Record<Quote['state'], string> = {
    live: '开市',
    closed: '休市',
    stale: '数据过期',
    error: '暂不可用',
  };
  tooltip.appendText(`${stock.name ?? quote.name} (${stock.symbol}) · ${stateText[quote.state]}`);
  tooltip.appendMarkdown('\n\n');
  const priceSummary =
    quote.price === null
      ? '—'
      : `${formatPrice(quote.price)} ${quote.currency}`;
  const changeSummary =
    quote.change === null || quote.changePercent === null
      ? '—'
      : `${quote.change > 0 ? '▲ ' : quote.change < 0 ? '▼ ' : ''}${formatDelta(quote.change)} (${formatPercent(quote.changePercent)})`;
  tooltip.appendMarkdown(`**${priceSummary} · ${changeSummary}**`);
  tooltip.appendMarkdown('\n\n');
  tooltip.appendMarkdown(
    [
      '| 指标 | 数值 | 指标 | 数值 |',
      '| :--- | ---: | :--- | ---: |',
      `| 今开 | ${formatOptionalPrice(quote.open)} | 最高 | ${formatOptionalPrice(quote.high)} |`,
      `| 昨收 | ${formatOptionalPrice(quote.previousClose)} | 最低 | ${formatOptionalPrice(quote.low)} |`,
      `| 成交量 | ${formatVolume(quote)} | 成交额 | ${formatMoney(quote.turnoverAmount, quote.currency)} |`,
      `| 换手率 | ${formatRatio(quote.turnoverRate, '%')} | 市盈率 TTM | ${formatRatio(quote.peTtm)} |`,
      `| 总市值 | ${formatMoney(quote.totalMarketCap, quote.currency)} | 状态 | ${stateText[quote.state]} |`,
    ].join('\n'),
  );
  tooltip.appendMarkdown('\n\n');
  tooltip.appendText(`更新时间：${timestamp} · 数据源：${providerName}`);
  if (quote.message) {
    tooltip.appendMarkdown('\n\n$(warning) ');
    tooltip.appendText(quote.message);
  }
  return tooltip;
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
      item.contextValue = 'fishStock.group';
      item.description = `${element.group.stocks.length}`;
      item.iconPath = new ThemeIcon(element.group.collapsed ? 'folder' : 'folder-opened');
      return item;
    }

    const item = new TreeItem(element.stock.name ?? element.quote?.name ?? element.stock.symbol);
    item.id = `stock:${element.stock.id}`;
    item.contextValue = 'fishStock.stock';
    item.description = quoteDescription(element.stock, element.quote);
    item.tooltip = quoteTooltip(element.stock, element.quote, this.providerName);
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
