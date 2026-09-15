import { MarkdownString } from 'vscode';
import { calculateHoldingMetrics, toDisplayAmount } from '../domain/holdings';
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
  hkdRate: number | null = null,
): MarkdownString {
  const tooltip = new MarkdownString();
  tooltip.supportThemeIcons = true;
  const name = holding.name ?? quote?.name ?? holding.symbol;
  const state = quoteStateText(quote);
  const metrics = calculateHoldingMetrics(holding, quote);
  tooltip.appendText(`${name} (${holding.symbol}) · ${state}`);
  tooltip.appendMarkdown('\n\n');
  if (metrics) {
    // 折算只作用于金额与单价；百分比是相对值，汇率在分子分母里约掉了。
    const converted = metrics.currency === 'HKD' && hkdRate !== null && hkdRate > 0;
    const unit = converted ? 'CNY' : metrics.currency;
    const amount = (value: number): number =>
      toDisplayAmount(value, metrics.currency, hkdRate);
    const dayProfitCell = metrics.dayProfit === null
      ? '—'
      : metrics.dayProfitPercent === null
        ? formatProfit(amount(metrics.dayProfit), unit)
        : `${formatProfit(amount(metrics.dayProfit), unit)} (${formatPercent(metrics.dayProfitPercent)})`;
    tooltip.appendMarkdown(
      `**${formatProfit(amount(metrics.profit), unit)} · ${formatPercent(metrics.returnPercent)}**`,
    );
    tooltip.appendMarkdown('\n\n');
    tooltip.appendMarkdown([
      '| 指标 | 数值 |',
      '| :--- | ---: |',
      `| 持有数量 | ${holding.quantity.toLocaleString('zh-CN')} ${holding.kind === 'fund' ? '份' : '股'} |`,
      `| 平均成本 | ${formatPrice(amount(holding.averageCost))} ${unit} |`,
      `| 当前价格 | ${formatPrice(amount(metrics.currentPrice))} ${unit} |`,
      `| 成本金额 | ${formatAmount(amount(metrics.costValue), unit)} |`,
      `| 当前市值 | ${formatAmount(amount(metrics.marketValue), unit)} |`,
      `| 浮动盈亏 | ${formatProfit(amount(metrics.profit), unit)} |`,
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
  const conversionNote = metrics !== undefined
    && metrics.currency === 'HKD'
    && hkdRate !== null
    && hkdRate > 0
    ? `；港币已按 1 HKD = ${hkdRate} CNY 折算为人民币`
    : '或汇率换算';
  tooltip.appendText(
    `说明：浮动盈亏未计入手续费、税费、分红${conversionNote}；`
    + '当日盈亏按当前持仓数量估算，未计入当日交易与费用，'
    + '其百分比以昨收市值为基准（收益率以持仓成本为基准），'
    + '非交易日或行情不属于当日时显示 —。'
    + '数据来自第三方公开行情源，与券商对账可能存在差异，请以券商为准。',
  );
  appendActionHint(tooltip, actionHint);
  return tooltip;
}
