import type {
  Holding,
  HoldingCurrency,
  HoldingsState,
  Market,
  MarketSessionPhase,
  Quote,
  QuoteStaleReason,
  QuoteState,
  WatchlistState,
} from './models';

export type DiagnosticRefreshState = 'not-run' | 'success' | 'error';
export type DiagnosticQuoteState = QuoteState | 'missing';
export type DiagnosticStaleReason = QuoteStaleReason | 'unspecified';

export interface DiagnosticWatchlistSummary {
  providerName: string;
  groupCount: number;
  collapsedGroupCount: number;
  itemCount: number;
  quoteStates: Readonly<Record<DiagnosticQuoteState, number>>;
  staleReasons: Readonly<Record<DiagnosticStaleReason, number>>;
  lastRefreshState: DiagnosticRefreshState;
  lastRefreshAt?: string;
  nextRetryAt?: string;
}

export interface DiagnosticHoldingsSummary {
  itemCount: number;
  currencies: Readonly<Record<HoldingCurrency, number>>;
  quoteStates: Readonly<Record<DiagnosticQuoteState, number>>;
}

export interface DiagnosticReport {
  generatedAt: string;
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  config: {
    refreshIntervalSeconds: number;
    staleAfterSeconds: number;
    rotationSeconds: number;
    colorConvention: string;
  };
  viewModes: {
    stock: string;
    fund: string;
    futures: string;
  };
  statusBarMode?: string;
  tradingDays: Readonly<Partial<Record<Market, boolean>>>;
  sessionPhases?: Readonly<Record<MarketSessionPhase, number>>;
  nextAutomaticRefreshAt?: string;
  calendarCoverage?: Readonly<Partial<Record<Market, string>>>;
  futuresSessionRules?: {
    supportedProductCount: number;
    uncoveredItemCount: number;
  };
  stock: DiagnosticWatchlistSummary;
  fund: DiagnosticWatchlistSummary;
  futures: DiagnosticWatchlistSummary;
  holdings?: DiagnosticHoldingsSummary;
}

const QUOTE_STATES: readonly DiagnosticQuoteState[] = [
  'live',
  'closed',
  'stale',
  'error',
  'missing',
];

const STALE_REASONS: readonly DiagnosticStaleReason[] = [
  'refresh-overdue',
  'quote-not-current',
  'future-timestamp',
  'session-uncovered',
  'unspecified',
];

export function summarizeWatchlist(
  state: WatchlistState,
  providerName: string,
  quoteOf: (
    symbol: string,
  ) => Pick<Quote, 'state' | 'staleReason'> | undefined,
  lastRefreshState: DiagnosticRefreshState,
  lastRefreshAt?: string,
  nextRetryAt?: string,
): DiagnosticWatchlistSummary {
  const quoteStates: Record<DiagnosticQuoteState, number> = {
    live: 0,
    closed: 0,
    stale: 0,
    error: 0,
    missing: 0,
  };
  const staleReasons: Record<DiagnosticStaleReason, number> = {
    'refresh-overdue': 0,
    'quote-not-current': 0,
    'future-timestamp': 0,
    'session-uncovered': 0,
    unspecified: 0,
  };
  let itemCount = 0;
  for (const group of state.groups) {
    for (const item of group.stocks) {
      itemCount += 1;
      const quote = quoteOf(item.symbol);
      quoteStates[quote?.state ?? 'missing'] += 1;
      if (quote?.state === 'stale') {
        staleReasons[quote.staleReason ?? 'unspecified'] += 1;
      }
    }
  }
  return {
    providerName,
    groupCount: state.groups.length,
    collapsedGroupCount: state.groups.filter((group) => group.collapsed).length,
    itemCount,
    quoteStates,
    staleReasons,
    lastRefreshState,
    ...(lastRefreshAt ? { lastRefreshAt } : {}),
    ...(nextRetryAt ? { nextRetryAt } : {}),
  };
}

export function summarizeHoldings(
  state: HoldingsState,
  quoteOf: (
    holding: Holding,
  ) => Pick<Quote, 'state' | 'staleReason'> | undefined,
): DiagnosticHoldingsSummary {
  const quoteStates: Record<DiagnosticQuoteState, number> = {
    live: 0,
    closed: 0,
    stale: 0,
    error: 0,
    missing: 0,
  };
  const currencies: Record<HoldingCurrency, number> = { CNY: 0, HKD: 0 };
  for (const holding of state.holdings) {
    currencies[holding.market === 'HK' ? 'HKD' : 'CNY'] += 1;
    quoteStates[quoteOf(holding)?.state ?? 'missing'] += 1;
  }
  return { itemCount: state.holdings.length, currencies, quoteStates };
}

function formatRefresh(summary: DiagnosticWatchlistSummary): string {
  if (summary.lastRefreshState === 'not-run') {
    return '尚未执行';
  }
  const state = summary.lastRefreshState === 'success' ? '成功' : '失败';
  return summary.lastRefreshAt ? `${state}（${summary.lastRefreshAt}）` : state;
}

function formatWatchlist(label: string, summary: DiagnosticWatchlistSummary): string[] {
  const quoteStates = QUOTE_STATES.map(
    (state) => `${state}=${summary.quoteStates[state]}`,
  ).join(', ');
  const staleReasons = STALE_REASONS.map(
    (reason) => `${reason}=${summary.staleReasons[reason]}`,
  ).join(', ');
  return [
    `${label}:`,
    `- 行情源：${summary.providerName}`,
    `- 分组：${summary.groupCount}（折叠 ${summary.collapsedGroupCount}）`,
    `- 条目：${summary.itemCount}`,
    `- 行情状态：${quoteStates}`,
    ...(summary.quoteStates.stale > 0
      ? [`- 过期原因：${staleReasons}`]
      : []),
    `- 最近刷新：${formatRefresh(summary)}`,
    ...(summary.nextRetryAt
      ? [`- 下次自动探测：${summary.nextRetryAt}（手动刷新可立即探测）`]
      : []),
  ];
}

export function formatDiagnosticReport(report: DiagnosticReport): string {
  const tradingDays = Object.entries(report.tradingDays)
    .map(([market, trading]) => `${market}=${trading ? '交易日' : '非交易日'}`)
    .join(', ');
  return [
    'FishStock 脱敏诊断信息',
    `生成时间：${report.generatedAt}`,
    `扩展版本：${report.extensionVersion}`,
    `VS Code：${report.vscodeVersion}`,
    `平台：${report.platform}`,
    '',
    '配置：',
    `- 自动刷新：${report.config.refreshIntervalSeconds} 秒`,
    `- 过期阈值：${report.config.staleAfterSeconds} 秒`,
    `- 状态栏轮播：${report.config.rotationSeconds} 秒`,
    `- 涨跌颜色：${report.config.colorConvention}`,
    `- 视图模式：Stock=${report.viewModes.stock}, Fund=${report.viewModes.fund}, Futures=${report.viewModes.futures}`,
    ...(report.statusBarMode
      ? [`- 状态栏模式：${report.statusBarMode}`]
      : []),
    `- 当日交易判断：${tradingDays || '无自选市场'}`,
    ...(report.sessionPhases
      ? [
          `- 当前交易阶段：trading=${report.sessionPhases.trading}, break=${report.sessionPhases.break}, closed=${report.sessionPhases.closed}, unknown=${report.sessionPhases.unknown}`,
        ]
      : []),
    ...(report.nextAutomaticRefreshAt
      ? [`- 下次计划自动刷新：${report.nextAutomaticRefreshAt}`]
      : []),
    ...(report.calendarCoverage
      ? [
          `- 交易日历覆盖：${Object.entries(report.calendarCoverage)
            .map(([market, end]) => `${market} 至 ${end}`)
            .join(', ') || '无自选市场'}`,
        ]
      : []),
    ...(report.futuresSessionRules
      ? [
          `- 期货时段规则：已收录 ${report.futuresSessionRules.supportedProductCount} 个品种，未覆盖自选 ${report.futuresSessionRules.uncoveredItemCount} 个`,
        ]
      : []),
    '',
    ...formatWatchlist('Stock', report.stock),
    '',
    ...formatWatchlist('Fund', report.fund),
    '',
    ...formatWatchlist('Futures', report.futures),
    ...(report.holdings
      ? [
          '',
          'Holdings:',
          `- 条目：${report.holdings.itemCount}`,
          `- 币种：CNY=${report.holdings.currencies.CNY}, HKD=${report.holdings.currencies.HKD}`,
          `- 行情状态：${QUOTE_STATES.map((state) => `${state}=${report.holdings?.quoteStates[state] ?? 0}`).join(', ')}`,
        ]
      : []),
    '',
    '隐私：本报告不包含自选名称、证券代码、持仓数量、成本、盈亏、文件路径或工作区信息。',
    '刷新错误详情请在 FishStock 输出日志中查看。',
  ].join('\n');
}
