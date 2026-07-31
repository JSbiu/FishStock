import {
  StatusBarAlignment,
  window,
  type Disposable,
  type StatusBarItem,
} from 'vscode';
import type { Quote, Stock, WatchlistState } from '../domain/models';
import type { QuoteService } from '../data/quoteService';
import { createQuoteTooltip, formatPrice } from './quoteTooltip';

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

export class StatusBarController implements Disposable {
  private readonly item: StatusBarItem;
  private entries: StatusBarEntry[] = [];
  private index = 0;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private rotationIntervalMs: number,
  ) {
    this.item = window.createStatusBarItem(StatusBarAlignment.Left, 10);
    this.item.name = 'FishStock 行情';
    this.item.command = 'fishStock.openWatchlist';
    this.item.show();
    this.restartTimer();
    this.render();
  }

  public setSources(sources: readonly StatusBarSource[]): void {
    this.entries = sources.flatMap((source) =>
      source.state.groups.flatMap((group) =>
        group.stocks.map((stock) => ({
          stock,
          quotes: source.quotes,
          providerName: source.providerName,
          openCommand: source.openCommand,
        })),
      ),
    );
    if (this.index >= this.entries.length) {
      this.index = 0;
    }
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
      if (this.entries.length > 0) {
        this.index = (this.index + 1) % this.entries.length;
      }
      this.render();
    }, this.rotationIntervalMs);
  }

  private render(): void {
    const entry = this.entries[this.index];
    if (!entry) {
      this.item.text = '$(pulse) FishStock';
      this.item.tooltip = '暂无自选行情。点击打开 FishStock。';
      this.item.command = 'fishStock.openWatchlist';
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
}

export interface StatusBarSource {
  state: WatchlistState;
  quotes: QuoteService;
  providerName: string;
  openCommand: string;
}

interface StatusBarEntry {
  stock: Stock;
  quotes: QuoteService;
  providerName: string;
  openCommand: string;
}
