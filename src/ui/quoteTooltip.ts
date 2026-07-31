import { MarkdownString } from 'vscode';
import type { Quote, Stock } from '../domain/models';
import { listingVenue } from '../domain/listingVenue';

export function formatPrice(price: number): string {
  return price.toFixed(price < 10 ? 3 : 2);
}

export function formatPercent(value: number): string {
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

function appendActionHint(tooltip: MarkdownString, actionHint: string | undefined): void {
  if (!actionHint) {
    return;
  }
  tooltip.appendMarkdown('\n\n---\n\n$(list-selection) ');
  tooltip.appendText(actionHint);
}

function quoteTable(stock: Stock, quote: Quote, state: string): string {
  if (quote.market === 'CNF') {
    return [
      '| 指标 | 数值 | 指标 | 数值 |',
      '| :--- | ---: | :--- | ---: |',
      `| 今开 | ${formatOptionalPrice(quote.open)} | 最高 | ${formatOptionalPrice(quote.high)} |`,
      `| 昨结 | ${formatOptionalPrice(quote.settlementPrice ?? quote.previousClose)} | 最低 | ${formatOptionalPrice(quote.low)} |`,
      `| 成交量 | ${formatVolume(quote)} | 持仓量 | ${quote.openInterest === null ? '—' : `${formatCompactNumber(quote.openInterest)}手`} |`,
      `| 交易所 | ${quote.venue ?? '—'} | 状态 | ${state} |`,
    ].join('\n');
  }

  const venue = listingVenue(stock.symbol);
  return [
    '| 指标 | 数值 | 指标 | 数值 |',
    '| :--- | ---: | :--- | ---: |',
    `| 今开 | ${formatOptionalPrice(quote.open)} | 最高 | ${formatOptionalPrice(quote.high)} |`,
    `| 昨收 | ${formatOptionalPrice(quote.previousClose)} | 最低 | ${formatOptionalPrice(quote.low)} |`,
    `| 成交量 | ${formatVolume(quote)} | 成交额 | ${formatMoney(quote.turnoverAmount, quote.currency)} |`,
    `| 换手率 | ${formatRatio(quote.turnoverRate, '%')} | 市盈率 TTM | ${formatRatio(quote.peTtm)} |`,
    venue
      ? `| 总市值 | ${formatMoney(quote.totalMarketCap, quote.currency)} | 上市板块 | ${venue} |`
      : `| 总市值 | ${formatMoney(quote.totalMarketCap, quote.currency)} | 状态 | ${state} |`,
  ].join('\n');
}

export function createQuoteTooltip(
  stock: Stock,
  quote: Quote | undefined,
  providerName: string,
  actionHint?: string,
): MarkdownString {
  const tooltip = new MarkdownString();
  tooltip.supportThemeIcons = true;
  if (!quote) {
    tooltip.appendText(`${stock.name ?? stock.symbol} (${stock.symbol})\n等待首次刷新`);
    appendActionHint(tooltip, actionHint);
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
  tooltip.appendMarkdown(quoteTable(stock, quote, stateText[quote.state]));
  tooltip.appendMarkdown('\n\n');
  tooltip.appendText(`更新时间：${timestamp} · 数据源：${providerName}`);
  if (quote.message) {
    tooltip.appendMarkdown('\n\n$(warning) ');
    tooltip.appendText(quote.message);
  }
  appendActionHint(tooltip, actionHint);
  return tooltip;
}
