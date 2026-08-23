import {
  StatusBarAlignment,
  window,
  type Disposable,
  type StatusBarItem,
} from 'vscode';
import { calculateHoldingMetrics } from '../domain/holdings';
import type {
  Holding,
  HoldingsState,
  Quote,
  Stock,
  WatchlistState,
} from '../domain/models';
import type { QuoteService } from '../data/quoteService';
import type { StatusBarDisplayMode } from '../storage/statusBarDisplayStore';
import type { StatusBarGroupKind } from '../storage/statusBarRotationStore';
import { createHoldingTooltip } from './holdingTooltip';
import { createQuoteTooltip, formatPrice } from './quoteTooltip';

const SELECT_GROUPS_COMMAND = 'fishStock.selectStatusBarGroups';

function displayText(stock: Stock, quote: Quote | undefined): string {
  const name = stock.name ?? quote?.name ?? stock.symbol;
  if (!quote || quote.price === null || quote.changePercent === null) {
    return `$(warning) ${name} --`;
  }
  const change = `${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%`;
  if (quote.state === 'closed') {
    return `$(clock) ${name} ${formatPrice(quote.price)} ${change}`;
  }
  if (quote.state === 'stale') {
    return `$(history) ${name} ${formatPrice(quote.price)} ${change}`;
  }
  if (quote.state === 'error') {
    return `$(warning) ${name} --`;
  }
  return `$(pulse) ${name} ${formatPrice(quote.price)} ${change}`;
}

function holdingDisplayText(holding: Holding, quote: Quote | undefined): string {
  const name = holding.name ?? quote?.name ?? holding.symbol;
  const metrics = calculateHoldingMetrics(holding, quote);
  if (!metrics) {
    return `$(warning) ${name} --`;
  }
  const profit = `${metrics.profit >= 0 ? '+' : ''}${metrics.profit.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${metrics.currency}`;
  const percent = `${metrics.returnPercent >= 0 ? '+' : ''}${metrics.returnPercent.toFixed(2)}%`;
  if (quote?.state === 'closed') {
    return `$(clock) ${name} ${profit} (${percent})`;
  }
  if (quote?.state === 'stale') {
    return `$(history) ${name} ${profit} (${percent})`;
  }
  if (quote?.state === 'error') {
    return `$(warning) ${name} --`;
  }
  return `$(pulse) ${name} ${profit} (${percent})`;
}

export class StatusBarController implements Disposable {
  private readonly item: StatusBarItem;
  private quoteEntries: QuoteStatusBarEntry[] = [];
  private holdingEntries: HoldingStatusBarEntry[] = [];
  private quoteIndex = 0;
  private holdingIndex = 0;
  private timer: NodeJS.Timeout | undefined;
  private hasIncludedQuoteGroups = true;

  public constructor(
    private rotationIntervalMs: number,
    private mode: StatusBarDisplayMode = 'quotes',
  ) {
    this.item = window.createStatusBarItem(StatusBarAlignment.Left, 10);
    this.item.name = 'FishStock 行情与持仓';
    this.item.command = 'fishStock.openWatchlist';
    this.item.show();
    this.restartTimer();
    this.render();
  }

  public setSources(sources: readonly StatusBarSource[]): void {
    const currentKey = this.quoteEntries[this.quoteIndex]?.key;
    let includedGroupCount = 0;
    this.quoteEntries = sources.flatMap((source) =>
      source.state.groups.flatMap((group) => {
        if (!source.isGroupIncluded(group.id)) {
          return [];
        }
        includedGroupCount += 1;
        return group.stocks.map((stock) => ({
          key: `${source.kind}:${stock.id}`,
          stock,
          quotes: source.quotes,
          providerName: source.providerName,
          openCommand: source.openCommand,
        }));
      }),
    );
    this.hasIncludedQuoteGroups = includedGroupCount > 0;
    const currentIndex = currentKey
      ? this.quoteEntries.findIndex((entry) => entry.key === currentKey)
      : -1;
    if (currentIndex >= 0) {
      this.quoteIndex = currentIndex;
    } else if (this.quoteIndex >= this.quoteEntries.length) {
      this.quoteIndex = 0;
    }
    this.render();
  }

  public setHoldingSource(source: HoldingStatusBarSource): void {
    const currentKey = this.holdingEntries[this.holdingIndex]?.key;
    this.holdingEntries = source.state.holdings.map((holding) => ({
      key: `holding:${holding.id}`,
      holding,
      quoteOf: source.quoteOf,
      providerNameOf: source.providerNameOf,
      openCommand: source.openCommand,
    }));
    const currentIndex = currentKey
      ? this.holdingEntries.findIndex((entry) => entry.key === currentKey)
      : -1;
    if (currentIndex >= 0) {
      this.holdingIndex = currentIndex;
    } else if (this.holdingIndex >= this.holdingEntries.length) {
      this.holdingIndex = 0;
    }
    this.render();
  }

  public setMode(mode: StatusBarDisplayMode): void {
    this.mode = mode;
    this.render();
  }

  public configure(rotationIntervalMs: number): void {
    this.rotationIntervalMs = rotationIntervalMs;
    this.restartTimer();
  }

  public dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.item.dispose();
  }

  private restartTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => {
      if (this.mode === 'holdings') {
        if (this.holdingEntries.length > 0) {
          this.holdingIndex = (this.holdingIndex + 1) % this.holdingEntries.length;
        }
      } else if (this.quoteEntries.length > 0) {
        this.quoteIndex = (this.quoteIndex + 1) % this.quoteEntries.length;
      }
      this.render();
    }, this.rotationIntervalMs);
  }

  private render(): void {
    if (this.mode === 'holdings') {
      this.renderHolding();
      return;
    }
    this.renderQuote();
  }

  private renderQuote(): void {
    const entry = this.quoteEntries[this.quoteIndex];
    if (!entry) {
      this.item.text = this.hasIncludedQuoteGroups
        ? '$(pulse) FishStock'
        : '$(debug-pause) FishStock';
      this.item.tooltip = this.hasIncludedQuoteGroups
        ? '已选择的轮播分组暂无自选行情。点击重新选择轮播分组。'
        : '状态栏轮播已关闭。点击选择参与轮播的分组。';
      this.item.command = SELECT_GROUPS_COMMAND;
      return;
    }
    const quote = entry.quotes.get(entry.stock.symbol);
    this.item.text = displayText(entry.stock, quote);
    this.item.tooltip = createQuoteTooltip(
      entry.stock,
      quote,
      entry.providerName,
      '点击打开自选列表',
    );
    this.item.command = entry.openCommand;
  }

  private renderHolding(): void {
    const entry = this.holdingEntries[this.holdingIndex];
    if (!entry) {
      this.item.text = '$(briefcase) FishStock';
      this.item.tooltip = '暂无持仓。点击打开 Holdings 添加持仓。';
      this.item.command = 'fishStock.openHoldings';
      return;
    }
    const quote = entry.quoteOf(entry.holding);
    this.item.text = holdingDisplayText(entry.holding, quote);
    this.item.tooltip = createHoldingTooltip(
      entry.holding,
      quote,
      entry.providerNameOf(entry.holding),
      '点击打开持仓列表',
    );
    this.item.command = entry.openCommand;
  }
}

export interface StatusBarSource {
  kind: StatusBarGroupKind;
  state: WatchlistState;
  quotes: QuoteService;
  providerName: string;
  openCommand: string;
  isGroupIncluded(groupId: string): boolean;
}

export interface HoldingStatusBarSource {
  state: HoldingsState;
  quoteOf(holding: Holding): Quote | undefined;
  providerNameOf(holding: Holding): string;
  openCommand: string;
}

interface QuoteStatusBarEntry {
  key: string;
  stock: Stock;
  quotes: QuoteService;
  providerName: string;
  openCommand: string;
}

interface HoldingStatusBarEntry {
  key: string;
  holding: Holding;
  quoteOf(holding: Holding): Quote | undefined;
  providerNameOf(holding: Holding): string;
  openCommand: string;
}
