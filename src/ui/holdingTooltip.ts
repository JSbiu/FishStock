import { MarkdownString } from 'vscode';
import { calculateHoldingMetrics } from '../domain/holdings';
import type { Holding, Quote } from '../domain/models';
import { formatPercent, formatPrice, quoteStaleLabel } from './quoteTooltip';

function formatAmount(value: number, currency: string): string {
  return `${value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

function formatProfit(value: number, currency: string): string {
  return `${value >= 0 ? '+' : ''}${formatAmount(value, currency)}`;
}

function formatMarketTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

function quoteStateText(quote: Quote | undefined): string {
  if (!quote || quote.state === 'error') {
    return '暂不可用';
  }
  if (quote.state === 'stale') {
    return quoteStaleLabel(quote);
  }
  if (quote.state === 'closed') {
    return quote.sessionLabel ?? '休市';
  }
  return quote.sessionLabel ? `开市 · ${quote.sessionLabel}` : '开市';
}

function appendActionHint(tooltip: MarkdownString, actionHint: string | undefined): void {
  if (!actionHint) {
    return;
  }
  tooltip.appendMarkdown('\n\n---\n\n$(list-selection) ');
  tooltip.appendText(actionHint);
}

export function createHoldingTooltip(
  holding: Holding,
  quote: Quote | undefined,
  providerName: string,
  actionHint?: string,
): MarkdownString {
  const tooltip = new MarkdownString();
  tooltip.supportThemeIcons = true;
  const name = holding.name ?? quote?.name ?? holding.symbol;
  const state = quoteStateText(quote);
  const metrics = calculateHoldingMetrics(holding, quote);
  tooltip.appendText(`${name} (${holding.symbol}) · ${state}`);
  tooltip.appendMarkdown('\n\n');
  if (metrics) {
    const dayProfitCell = metrics.dayProfit === null
      ? '—'
      : metrics.dayProfitPercent === null
        ? formatProfit(metrics.dayProfit, metrics.currency)
        : `${formatProfit(metrics.dayProfit, metrics.currency)} (${formatPercent(metrics.dayProfitPercent)})`;
    tooltip.appendMarkdown(
      `**${formatProfit(metrics.profit, metrics.currency)} · ${formatPercent(metrics.returnPercent)}**`,
    );
    tooltip.appendMarkdown('\n\n');
    tooltip.appendMarkdown([
      '| 指标 | 数值 |',
      '| :--- | ---: |',
      `| 持有数量 | ${holding.quantity.toLocaleString('zh-CN')} ${holding.kind === 'fund' ? '份' : '股'} |`,
      `| 平均成本 | ${formatPrice(holding.averageCost)} ${metrics.currency} |`,
      `| 当前价格 | ${formatPrice(metrics.currentPrice)} ${metrics.currency} |`,
      `| 成本金额 | ${formatAmount(metrics.costValue, metrics.currency)} |`,
      `| 当前市值 | ${formatAmount(metrics.marketValue, metrics.currency)} |`,
      `| 浮动盈亏 | ${formatProfit(metrics.profit, metrics.currency)} |`,
      `| 收益率 | ${formatPercent(metrics.returnPercent)} |`,
      `| 当日盈亏 | ${dayProfitCell} |`,
    ].join('\n'));
  } else {
    tooltip.appendText('当前没有可用于计算收益的有效价格。');
  }
  tooltip.appendMarkdown('\n\n');
  const quoteTime = quote && quote.asOf > 0 ? formatMarketTime(quote.asOf) : '无';
  const fetchedAt = quote?.lastSuccessfulFetchAt !== undefined
    ? formatMarketTime(quote.lastSuccessfulFetchAt)
    : '无';
  tooltip.appendText(
    `行情时间：${quoteTime} · 最近获取：${fetchedAt} · 数据源：${providerName}`,
  );
  if (quote?.message) {
    tooltip.appendMarkdown('\n\n$(warning) ');
    tooltip.appendText(quote.message);
  }
  tooltip.appendMarkdown('\n\n');
  tooltip.appendText(
    '说明：浮动盈亏未计入手续费、税费、分红或汇率换算；'
    + '当日盈亏按当前持仓数量估算，未计入当日交易与费用，'
    + '其百分比以昨收市值为基准（收益率以持仓成本为基准），'
    + '非交易日或行情不属于当日时显示 —。',
  );
  appendActionHint(tooltip, actionHint);
  return tooltip;
}
