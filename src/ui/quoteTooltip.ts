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

export function quoteStaleLabel(quote: Quote): string {
  if (quote.staleReason === 'refresh-overdue') {
    return '刷新超时';
  }
  if (quote.staleReason === 'quote-not-current') {
    return quote.sessionPhase === 'closed'
      ? '最近交易日行情缺失'
      : '等待当日行情';
  }
  if (quote.staleReason === 'future-timestamp') {
    return '行情时间异常';
  }
  if (quote.staleReason === 'session-uncovered') {
    return '时段未收录';
  }
  return '数据过期';
}

function quoteStateText(quote: Quote): string {
  if (quote.state === 'live') {
    return quote.sessionLabel ? `开市 · ${quote.sessionLabel}` : '开市';
  }
  if (quote.state === 'closed') {
    return quote.sessionLabel ?? '休市';
  }
  if (quote.state === 'stale') {
    const label = quoteStaleLabel(quote);
    return quote.sessionLabel ? `${label} · ${quote.sessionLabel}` : label;
  }
  return quote.sessionLabel ? `暂不可用 · ${quote.sessionLabel}` : '暂不可用';
}

/**
 * 紧凑时间：省略年份，只留「月/日 时:分:秒」。
 * 底部元信息用的是当天或近日的时间戳，带年份只是拉长这一行。
 */
export function formatCompactTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * 单列两行表：指标 / 数值。
 *
 * 原先是四列并排（指标|数值|指标|数值），但 tooltip 很窄，第 2 列的数值与第 3 列
 * 的指标之间没有任何分隔，读起来会连成一串（"17.30 最高"、"2,289.57亿 CNY 上市板块"）。
 * 单列会多出几行，但每行只有一个主谓，扫读时不会串列。
 */
function quoteTable(stock: Stock, quote: Quote, state: string): string {
  if (quote.market === 'CNF') {
    return [
      '| 指标 | 数值 |',
      '| :--- | ---: |',
      `| 今开 | ${formatOptionalPrice(quote.open)} |`,
      `| 昨结 | ${formatOptionalPrice(quote.settlementPrice ?? quote.previousClose)} |`,
      `| 最高 | ${formatOptionalPrice(quote.high)} |`,
      `| 最低 | ${formatOptionalPrice(quote.low)} |`,
      `| 成交量 | ${formatVolume(quote)} |`,
      `| 持仓量 | ${quote.openInterest === null ? '—' : `${formatCompactNumber(quote.openInterest)}手`} |`,
      `| 交易所 | ${quote.venue ?? '—'} |`,
      `| 状态 | ${state} |`,
    ].join('\n');
  }

  const venue = listingVenue(stock.symbol);
  return [
    '| 指标 | 数值 |',
    '| :--- | ---: |',
    `| 今开 | ${formatOptionalPrice(quote.open)} |`,
    `| 昨收 | ${formatOptionalPrice(quote.previousClose)} |`,
    `| 最高 | ${formatOptionalPrice(quote.high)} |`,
    `| 最低 | ${formatOptionalPrice(quote.low)} |`,
    `| 成交量 | ${formatVolume(quote)} |`,
    `| 成交额 | ${formatMoney(quote.turnoverAmount, quote.currency)} |`,
    `| 换手率 | ${formatRatio(quote.turnoverRate, '%')} |`,
    `| 市盈率 TTM | ${formatRatio(quote.peTtm)} |`,
    `| 总市值 | ${formatMoney(quote.totalMarketCap, quote.currency)} |`,
    // 状态已在标题行给出，这里不再重复占一行。
    ...(venue ? [`| 上市板块 | ${venue} |`] : []),
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

  const state = quoteStateText(quote);
  // 标题行必须短。它是 tooltip 里最容易被撑宽的一行，而 Markdown 表格会撑满容器、
  // 列内两端对齐——一旦标题比表格内容宽，表格右侧就会空出一大块（用户圈出的正是这里）。
  // 因此「下次开市」这类次要信息不进标题，放到下方元信息行。
  tooltip.appendText(`${stock.name ?? quote.name} (${stock.symbol}) · ${state}`);
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
  tooltip.appendMarkdown(quoteTable(stock, quote, state));
  tooltip.appendMarkdown('\n\n');
  // 元信息行同样要保持短：它是除表格外最容易撑宽容器的内容，而容器一宽，
  // 表格右侧就会留白。只保留行情时间与数据源（「最近获取」是内部刷新时刻，
  // 长度不小而价值有限）。
  tooltip.appendMarkdown('$(pulse) ');
  tooltip.appendText(
    `行情 ${quote.asOf > 0 ? formatCompactTime(quote.asOf) : '无'} · ${providerName}`,
  );
  if (quote.nextOpenAt !== undefined && quote.state !== 'live') {
    tooltip.appendMarkdown('\n\n$(clock) ');
    tooltip.appendText(`下次开市 ${formatCompactTime(quote.nextOpenAt)}`);
  }
  if (quote.message) {
    tooltip.appendMarkdown('\n\n$(warning) ');
    tooltip.appendText(quote.message);
  }
  appendActionHint(tooltip, actionHint);
  return tooltip;
}
