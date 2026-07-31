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
  private stocks: Stock[] = [];
  private index = 0;
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly quotes: QuoteService,
    private rotationIntervalMs: number,
    private readonly providerName: string,
  ) {
    this.item = window.createStatusBarItem(StatusBarAlignment.Left, 10);
    this.item.name = 'FishStock 行情';
    this.item.command = 'fishStock.openWatchlist';
    this.item.show();
    this.restartTimer();
    this.render();
  }

  public setState(state: WatchlistState): void {
    this.stocks = state.groups.flatMap((group) => group.stocks);
    if (this.index >= this.stocks.length) {
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
      if (this.stocks.length > 0) {
        this.index = (this.index + 1) % this.stocks.length;
      }
      this.render();
    }, this.rotationIntervalMs);
  }

  private render(): void {
    const stock = this.stocks[this.index];
    if (!stock) {
      this.item.text = '$(pulse) FishStock';
      this.item.tooltip = '暂无自选股。点击打开 FishStock。';
      return;
    }
    const quote = this.quotes.get(stock.symbol);
    this.item.text = displayText(stock, quote);
    this.item.tooltip = createQuoteTooltip(
      stock,
      quote,
      this.providerName,
      '点击打开自选列表',
    );
  }
}
