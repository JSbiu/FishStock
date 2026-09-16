import { MarkdownString } from 'vscode';
import { calculateHoldingMetrics, toDisplayAmount } from '../domain/holdings';
import type { Holding, Quote } from '../domain/models';
import { formatCompactTime, formatPercent, formatPrice, quoteStaleLabel } from './quoteTooltip';

function formatAmount(value: number, currency: string): string {
  return `${value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

function formatProfit(value: number, currency: string): string {
  return `${value >= 0 ? '+' : ''}${formatAmount(value, currency)}`;
}

/**
 * 状态行。tooltip 里的 Markdown 无法自定义文字颜色，只能靠 codicon 图标承载
 * 「停牌 / 休市 / 开市」这类语义差异。
 *
 * 停牌必须排在 state 判断之前：停牌时行情源照常返回有效价格，state 仍是 live，
 * 若不先拦下来，悬浮卡会说「开市」而 Tree View 说「停牌」，两处口径就不一致了。
 */
function quoteStateMarkdown(quote: Quote | undefined): string {
  if (!quote || quote.state === 'error') {
    return '$(warning) 暂不可用';
  }
  if (quote.suspended === true) {
    return '$(debug-pause) 停牌';
  }
  if (quote.state === 'stale') {
    return `$(history) ${quoteStaleLabel(quote)}`;
  }
  if (quote.state === 'closed') {
    return `$(clock) ${quote.sessionLabel ?? '休市'}`;
  }
  return quote.sessionLabel
    ? `$(radio-tower) 开市 · ${quote.sessionLabel}`
    : '$(radio-tower) 开市';
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
  const metrics = calculateHoldingMetrics(holding, quote);
  tooltip.appendMarkdown(`**${name}** (${holding.symbol}) · ${quoteStateMarkdown(quote)}`);
  tooltip.appendMarkdown('\n\n');
  // 折算只作用于金额与单价；百分比是相对值，汇率在分子分母里约掉了。
  const converted = metrics !== undefined
    && metrics.currency === 'HKD'
    && hkdRate !== null
    && hkdRate > 0;
  if (metrics) {
    const unit = converted ? 'CNY' : metrics.currency;
    const amount = (value: number): number =>
      toDisplayAmount(value, metrics.currency, hkdRate);
    const directionIcon = metrics.profit > 0
      ? '$(arrow-up)'
      : metrics.profit < 0
        ? '$(arrow-down)'
        : '$(dash)';
    const dayProfitCell = metrics.dayProfit === null
      ? '—'
      : metrics.dayProfitPercent === null
        ? formatProfit(amount(metrics.dayProfit), unit)
        : `${formatProfit(amount(metrics.dayProfit), unit)} (${formatPercent(metrics.dayProfitPercent)})`;
    tooltip.appendMarkdown(
      `${directionIcon} **${formatProfit(amount(metrics.profit), unit)} · ${formatPercent(metrics.returnPercent)}**`,
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
  const quoteTime = quote && quote.asOf > 0 ? formatCompactTime(quote.asOf) : '无';
  const fetchedAt = quote?.lastSuccessfulFetchAt !== undefined
    ? formatCompactTime(quote.lastSuccessfulFetchAt)
    : '无';
  tooltip.appendMarkdown('$(pulse) ');
  tooltip.appendText(`行情 ${quoteTime} · 获取 ${fetchedAt} · ${providerName}`);
  if (quote?.message) {
    tooltip.appendMarkdown('\n\n$(warning) ');
    tooltip.appendText(quote.message);
  }
  if (converted) {
    tooltip.appendMarkdown('\n\n$(globe) ');
    tooltip.appendText(`港币已按 ${hkdRate} 折算；百分比不受影响。`);
  }
  // 口径说明与数据来源拆开，避免压成一段后重点被淹掉。
  // 说明必须短。它是 tooltip 里最容易超长的一行，而 Markdown 表格会撑满容器、
  // 列内两端对齐——说明一旦比表格行宽，容器就被撑开，表格右侧随之留白。
  // 这里每句控制在 25 字以内，与表格中最长的行（约 30 字符）保持接近。
  tooltip.appendMarkdown('\n\n---\n\n$(info) ');
  tooltip.appendText('浮动盈亏未含税费与分红；当日盈亏按持仓数量估算。');
  tooltip.appendMarkdown('\n\n$(shield) ');
  tooltip.appendText('来自第三方公开源，与券商对账可能有差异。');
  appendActionHint(tooltip, actionHint);
  return tooltip;
}
