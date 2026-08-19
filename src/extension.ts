import {
  commands,
  env,
  ExtensionMode,
  window,
  workspace,
  version as vscodeVersion,
  type ExtensionContext,
  type QuickPickItem,
  type TreeView,
} from 'vscode';
import {
  buildFundCommandSet,
  buildFuturesCommandSet,
  buildStockCommandSet,
} from './commands/commandSets';
import { registerWatchlistCommands } from './commands/registerWatchlistCommands';
import { readConfig } from './config';
import { BseSecurityDirectory } from './data/bseSecurityDirectory';
import { QuoteService } from './data/quoteService';
import { SinaFuturesProvider } from './data/sinaFuturesProvider';
import { TencentDataProvider } from './data/tencentDataProvider';
import {
  formatDiagnosticReport,
  summarizeWatchlist,
  type DiagnosticRefreshState,
} from './domain/diagnostics';
import type {
  Market,
  MarketSession,
  NormalizedSymbol,
  RefreshResult,
} from './domain/models';
import {
  futuresSessionRule,
  supportedFuturesProductCount,
} from './domain/futuresSessions';
import { marketSessionFor, shouldAutoRefreshSymbol } from './domain/marketSessions';
import { calendarCoverageEnd, isTradingDay } from './domain/tradingCalendar';
import { startBackgroundRefresh } from './services/backgroundRefresh';
import { MarketSessionMonitor } from './services/marketSessionMonitor';
import { RefreshScheduler } from './services/refreshScheduler';
import {
  StatusBarRotationStore,
  type StatusBarGroupIds,
  type StatusBarGroupKind,
} from './storage/statusBarRotationStore';
import {
  createDefaultFundWatchlist,
  createDefaultFuturesWatchlist,
  WatchlistRepository,
} from './storage/watchlistRepository';
import { ViewOptionsStore } from './storage/viewOptionsStore';
import {
  GroupNode,
  WatchlistTreeProvider,
  type FishTreeNode,
} from './ui/watchlistTreeProvider';
import { StatusBarController } from './ui/statusBarController';
import { refreshTreeWhenVisible } from './ui/refreshTreeWhenVisible';

const MIN_FETCH_INTERVAL_MS = 10_000;
const SELECT_STATUS_BAR_GROUPS_COMMAND = 'fishStock.selectStatusBarGroups';

interface StatusBarGroupPick extends QuickPickItem {
  viewKind: StatusBarGroupKind;
  groupId: string;
}

function compactError(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

function extensionVersion(context: ExtensionContext): string {
  const manifest: unknown = context.extension.packageJSON;
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) {
    return '未知';
  }
  return typeof manifest.version === 'string' ? manifest.version : '未知';
}

function watchlistSymbols(repository: WatchlistRepository): NormalizedSymbol[] {
  return repository.getSnapshot().groups.flatMap((group) =>
    group.stocks.map((item) => ({ symbol: item.symbol, market: item.market })),
  );
}

function sessionWithFreshness(
  quotes: QuoteService,
  symbol: NormalizedSymbol,
  now: Date,
): MarketSession {
  const session = marketSessionFor(symbol, now);
  const freshnessTransition = quotes.nextStateChangeAt(symbol.symbol, now.getTime());
  if (
    freshnessTransition === undefined ||
    (session.nextTransitionAt !== undefined &&
      session.nextTransitionAt <= freshnessTransition)
  ) {
    return session;
  }
  return { ...session, nextTransitionAt: freshnessTransition };
}

function manualSuccessMessage(
  label: string,
  symbols: readonly NormalizedSymbol[],
  now = new Date(),
): string {
  const sessions = symbols.map((symbol) => marketSessionFor(symbol, now));
  if (sessions.some((session) => session.phase === 'unknown')) {
    return `FishStock: ${label}已获取最近行情，部分期货交易时段未收录`;
  }
  if (
    sessions.length > 0 &&
    sessions.every((session) => session.phase !== 'trading')
  ) {
    return `FishStock: ${label}已获取最近行情，当前休市`;
  }
  return `FishStock: ${label}行情已刷新`;
}

function manualFailureMessage(label: string, result: RefreshResult): string {
  const hasCache = [...result.quotes.values()].some((quote) => quote.price !== null);
  return hasCache
    ? `FishStock: ${label}行情刷新失败，保留最近行情`
    : `FishStock: ${label}行情刷新失败，暂不可用`;
}

async function expandAllGroups(
  repository: WatchlistRepository,
  provider: WatchlistTreeProvider,
  treeView: TreeView<FishTreeNode>,
): Promise<void> {
  await repository.expandAllGroups();
  provider.refresh();
  for (const group of provider.getGroupNodes()) {
    await treeView.reveal(group, { expand: true, focus: false, select: false });
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
  const output = window.createOutputChannel('FishStock');
  const stockRepository = new WatchlistRepository(context.globalState);
  const fundRepository = new WatchlistRepository(context.globalState, {
    storageKey: 'fishStock.funds.v1',
    createDefault: createDefaultFundWatchlist,
  });
  const futuresRepository = new WatchlistRepository(context.globalState, {
    storageKey: 'fishStock.futures.v1',
    createDefault: createDefaultFuturesWatchlist,
  });
  const viewOptions = new ViewOptionsStore(context.globalState);
  const statusBarRotation = new StatusBarRotationStore(context.globalState);
  await Promise.all([
    stockRepository.load(),
    fundRepository.load(),
    futuresRepository.load(),
    viewOptions.load(),
    statusBarRotation.load(),
  ]);

  let config = readConfig();
  const stockProvider = new TencentDataProvider({
    bseDirectory: new BseSecurityDirectory(context.globalState),
  });
  const fundProvider = new TencentDataProvider();
  const futuresProvider = new SinaFuturesProvider();
  const stockQuotes = new QuoteService(
    stockProvider,
    MIN_FETCH_INTERVAL_MS,
    config.staleAfterMs,
    Date.now,
    marketSessionFor,
  );
  const futuresQuotes = new QuoteService(
    futuresProvider,
    MIN_FETCH_INTERVAL_MS,
    config.staleAfterMs,
    Date.now,
    marketSessionFor,
  );
  const fundQuotes = new QuoteService(
    fundProvider,
    MIN_FETCH_INTERVAL_MS,
    config.staleAfterMs,
    Date.now,
    marketSessionFor,
  );
  const stockTreeProvider = new WatchlistTreeProvider(
    stockRepository,
    stockQuotes,
    config.colorConvention,
    stockProvider.displayName,
    {},
    viewOptions.getSnapshot().stock,
  );
  const futuresTreeProvider = new WatchlistTreeProvider(
    futuresRepository,
    futuresQuotes,
    config.colorConvention,
    futuresProvider.displayName,
    {
      groupContextValue: 'fishStock.futuresGroup',
      itemContextValue: 'fishStock.future',
    },
    viewOptions.getSnapshot().futures,
  );
  const fundTreeProvider = new WatchlistTreeProvider(
    fundRepository,
    fundQuotes,
    config.colorConvention,
    fundProvider.displayName,
    {
      groupContextValue: 'fishStock.fundGroup',
      itemContextValue: 'fishStock.fund',
    },
    viewOptions.getSnapshot().fund,
  );
  const stockTreeView = window.createTreeView('fishStock.stock', {
    treeDataProvider: stockTreeProvider,
    showCollapseAll: true,
  });
  const futuresTreeView = window.createTreeView('fishStock.futures', {
    treeDataProvider: futuresTreeProvider,
    showCollapseAll: true,
  });
  const fundTreeView = window.createTreeView('fishStock.fund', {
    treeDataProvider: fundTreeProvider,
    showCollapseAll: true,
  });
  const stockTreeRefresh = refreshTreeWhenVisible(stockTreeView, stockTreeProvider);
  const fundTreeRefresh = refreshTreeWhenVisible(fundTreeView, fundTreeProvider);
  const futuresTreeRefresh = refreshTreeWhenVisible(futuresTreeView, futuresTreeProvider);

  const statusBar = new StatusBarController(config.rotationIntervalMs);
  let stockRefreshState: DiagnosticRefreshState = 'not-run';
  let stockRefreshAt: string | undefined;
  let fundRefreshState: DiagnosticRefreshState = 'not-run';
  let fundRefreshAt: string | undefined;
  let futuresRefreshState: DiagnosticRefreshState = 'not-run';
  let futuresRefreshAt: string | undefined;
  const sessionMonitors: {
    stock?: MarketSessionMonitor;
    fund?: MarketSessionMonitor;
    futures?: MarketSessionMonitor;
  } = {};
  const statusBarGroupIds = (): StatusBarGroupIds => ({
    stock: stockRepository.getSnapshot().groups.map((group) => group.id),
    fund: fundRepository.getSnapshot().groups.map((group) => group.id),
    futures: futuresRepository.getSnapshot().groups.map((group) => group.id),
  });
  const updateStatusBar = (): void => {
    statusBar.setSources([
      {
        kind: 'stock',
        state: stockRepository.getSnapshot(),
        quotes: stockQuotes,
        providerName: stockProvider.displayName,
        openCommand: 'fishStock.openWatchlist',
        isGroupIncluded: (groupId) => statusBarRotation.isGroupIncluded('stock', groupId),
      },
      {
        kind: 'fund',
        state: fundRepository.getSnapshot(),
        quotes: fundQuotes,
        providerName: fundProvider.displayName,
        openCommand: 'fishStock.openFunds',
        isGroupIncluded: (groupId) => statusBarRotation.isGroupIncluded('fund', groupId),
      },
      {
        kind: 'futures',
        state: futuresRepository.getSnapshot(),
        quotes: futuresQuotes,
        providerName: futuresProvider.displayName,
        openCommand: 'fishStock.openFutures',
        isGroupIncluded: (groupId) => statusBarRotation.isGroupIncluded('futures', groupId),
      },
    ]);
  };

  const refreshFunds = async (
    force: boolean,
    manual: boolean,
    selectedSymbols?: readonly NormalizedSymbol[],
  ): Promise<void> => {
    if (!manual && !fundProvider.canAutomaticallyRefresh()) {
      return;
    }
    const symbols = selectedSymbols ?? watchlistSymbols(fundRepository);
    const result = await fundQuotes.refresh(symbols, force);
    fundRefreshState = result.error ? 'error' : 'success';
    fundRefreshAt = new Date().toISOString();
    fundTreeRefresh.requestRefresh();
    updateStatusBar();
    sessionMonitors.fund?.refresh();
    if (result.error) {
      output.appendLine(`[${new Date().toISOString()}] 基金行情刷新失败：${result.error}`);
      if (manual) {
        window.setStatusBarMessage(manualFailureMessage('基金', result), 4_000);
      }
    } else if (manual) {
      window.setStatusBarMessage(manualSuccessMessage('基金', symbols), 2_500);
    }
  };
  updateStatusBar();

  const refreshStocks = async (
    force: boolean,
    manual: boolean,
    selectedSymbols?: readonly NormalizedSymbol[],
  ): Promise<void> => {
    if (!manual && !stockProvider.canAutomaticallyRefresh()) {
      return;
    }
    const symbols = selectedSymbols ?? watchlistSymbols(stockRepository);
    const result = await stockQuotes.refresh(symbols, force);
    stockRefreshState = result.error ? 'error' : 'success';
    stockRefreshAt = new Date().toISOString();
    stockTreeRefresh.requestRefresh();
    updateStatusBar();
    sessionMonitors.stock?.refresh();
    if (result.error) {
      output.appendLine(`[${new Date().toISOString()}] 股票行情刷新失败：${result.error}`);
      if (manual) {
        window.setStatusBarMessage(manualFailureMessage('股票', result), 4_000);
      }
    } else if (manual) {
      window.setStatusBarMessage(manualSuccessMessage('股票', symbols), 2_500);
    }
  };

  const refreshFutures = async (
    force: boolean,
    manual: boolean,
    selectedSymbols?: readonly NormalizedSymbol[],
  ): Promise<void> => {
    if (!manual && !futuresProvider.canAutomaticallyRefresh()) {
      return;
    }
    const symbols = selectedSymbols ?? watchlistSymbols(futuresRepository);
    const result = await futuresQuotes.refresh(symbols, force);
    futuresRefreshState = result.error ? 'error' : 'success';
    futuresRefreshAt = new Date().toISOString();
    futuresTreeRefresh.requestRefresh();
    updateStatusBar();
    sessionMonitors.futures?.refresh();
    if (result.error) {
      output.appendLine(`[${new Date().toISOString()}] 期货行情刷新失败：${result.error}`);
      if (manual) {
        window.setStatusBarMessage(manualFailureMessage('期货', result), 4_000);
      }
    } else if (manual) {
      window.setStatusBarMessage(manualSuccessMessage('期货', symbols), 2_500);
    }
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.all([
      refreshStocks(false, false),
      refreshFunds(false, false),
      refreshFutures(false, false),
    ]);
  };

  const activeStockMarkets = (): Market[] => [
    ...new Set([
      ...stockRepository
        .getSnapshot()
        .groups.flatMap((group) => group.stocks.map((stock) => stock.market)),
    ]),
  ];
  const activeFuturesMarkets = (): Market[] => [
    ...new Set([
      ...futuresRepository
        .getSnapshot()
        .groups.flatMap((group) => group.stocks.map((stock) => stock.market)),
    ]),
  ];
  const activeFundMarkets = (): Market[] => [
    ...new Set([
      ...fundRepository
        .getSnapshot()
        .groups.flatMap((group) => group.stocks.map((fund) => fund.market)),
    ]),
  ];
  const activeMarkets = (): Market[] => [
    ...new Set([
      ...activeStockMarkets(),
      ...activeFundMarkets(),
      ...activeFuturesMarkets(),
    ]),
  ];
  const diagnosticReport = (): string => {
    const tradingDays: Partial<Record<Market, boolean>> = {};
    const now = new Date();
    for (const market of activeMarkets()) {
      tradingDays[market] = isTradingDay(market, now);
    }
    const symbols = [
      ...watchlistSymbols(stockRepository),
      ...watchlistSymbols(fundRepository),
      ...watchlistSymbols(futuresRepository),
    ];
    const sessions = symbols.map((symbol) => marketSessionFor(symbol, now));
    const sessionPhases = {
      trading: sessions.filter((session) => session.phase === 'trading').length,
      break: sessions.filter((session) => session.phase === 'break').length,
      closed: sessions.filter((session) => session.phase === 'closed').length,
      unknown: sessions.filter((session) => session.phase === 'unknown').length,
    };
    const nextAutomaticRefreshAt = sessions
      .map((session) =>
        session.phase === 'trading'
          ? now.getTime() + config.refreshIntervalMs
          : session.nextOpenAt,
      )
      .filter((timestamp): timestamp is number => timestamp !== undefined)
      .sort((left, right) => left - right)[0];
    const calendarCoverage: Partial<Record<Market, string>> = {};
    for (const market of activeMarkets()) {
      const end = calendarCoverageEnd(market);
      if (end) {
        calendarCoverage[market] = end;
      }
    }
    const modes = viewOptions.getSnapshot();
    return formatDiagnosticReport({
      generatedAt: now.toISOString(),
      extensionVersion: extensionVersion(context),
      vscodeVersion,
      platform: `${process.platform}-${process.arch}`,
      config: {
        refreshIntervalSeconds: config.refreshIntervalMs / 1000,
        staleAfterSeconds: config.staleAfterMs / 1000,
        rotationSeconds: config.rotationIntervalMs / 1000,
        colorConvention: config.colorConvention,
      },
      viewModes: { stock: modes.stock, fund: modes.fund, futures: modes.futures },
      tradingDays,
      sessionPhases,
      ...(nextAutomaticRefreshAt
        ? { nextAutomaticRefreshAt: new Date(nextAutomaticRefreshAt).toISOString() }
        : {}),
      calendarCoverage,
      futuresSessionRules: {
        supportedProductCount: supportedFuturesProductCount(),
        uncoveredItemCount: watchlistSymbols(futuresRepository).filter(
          (symbol) => futuresSessionRule(symbol.symbol) === undefined,
        ).length,
      },
      stock: summarizeWatchlist(
        stockRepository.getSnapshot(),
        stockProvider.displayName,
        (symbol) => stockQuotes.get(symbol),
        stockRefreshState,
        stockRefreshAt,
        stockProvider.getNextAutomaticRetryAt()?.toISOString(),
      ),
      fund: summarizeWatchlist(
        fundRepository.getSnapshot(),
        fundProvider.displayName,
        (symbol) => fundQuotes.get(symbol),
        fundRefreshState,
        fundRefreshAt,
        fundProvider.getNextAutomaticRetryAt()?.toISOString(),
      ),
      futures: summarizeWatchlist(
        futuresRepository.getSnapshot(),
        futuresProvider.displayName,
        (symbol) => futuresQuotes.get(symbol),
        futuresRefreshState,
        futuresRefreshAt,
        futuresProvider.getNextAutomaticRetryAt()?.toISOString(),
      ),
    });
  };
  const scheduler = new RefreshScheduler(config.refreshIntervalMs, async () => {
    try {
      const now = new Date();
      const stockSymbols = watchlistSymbols(stockRepository).filter((symbol) =>
        shouldAutoRefreshSymbol(symbol, now),
      );
      const fundSymbols = watchlistSymbols(fundRepository).filter((symbol) =>
        shouldAutoRefreshSymbol(symbol, now),
      );
      const futuresSymbols = watchlistSymbols(futuresRepository).filter((symbol) =>
        shouldAutoRefreshSymbol(symbol, now),
      );
      await Promise.all([
        stockSymbols.length > 0
          ? refreshStocks(false, false, stockSymbols)
          : Promise.resolve(),
        fundSymbols.length > 0
          ? refreshFunds(false, false, fundSymbols)
          : Promise.resolve(),
        futuresSymbols.length > 0
          ? refreshFutures(false, false, futuresSymbols)
          : Promise.resolve(),
      ]);
    } catch (error: unknown) {
      output.appendLine(`[${new Date().toISOString()}] 刷新任务异常：${compactError(error)}`);
    }
  });

  const transitionTargets = (
    opened: readonly NormalizedSymbol[],
    closed: readonly NormalizedSymbol[],
  ): NormalizedSymbol[] => [
    ...new Map([...opened, ...closed].map((symbol) => [symbol.symbol, symbol])).values(),
  ];
  const logSessionMonitorError = (error: unknown): void => {
    output.appendLine(`[${new Date().toISOString()}] 时段切换任务异常：${compactError(error)}`);
  };
  sessionMonitors.stock = new MarketSessionMonitor(
    () => watchlistSymbols(stockRepository),
    (symbol, now) => sessionWithFreshness(stockQuotes, symbol, now),
    async ({ opened, closed }) => {
      stockTreeRefresh.requestRefresh();
      updateStatusBar();
      const symbols = transitionTargets(opened, closed);
      if (symbols.length > 0) {
        await refreshStocks(true, false, symbols);
      }
    },
    logSessionMonitorError,
  );
  sessionMonitors.fund = new MarketSessionMonitor(
    () => watchlistSymbols(fundRepository),
    (symbol, now) => sessionWithFreshness(fundQuotes, symbol, now),
    async ({ opened, closed }) => {
      fundTreeRefresh.requestRefresh();
      updateStatusBar();
      const symbols = transitionTargets(opened, closed);
      if (symbols.length > 0) {
        await refreshFunds(true, false, symbols);
      }
    },
    logSessionMonitorError,
  );
  sessionMonitors.futures = new MarketSessionMonitor(
    () => watchlistSymbols(futuresRepository),
    (symbol, now) => sessionWithFreshness(futuresQuotes, symbol, now),
    async ({ opened, closed }) => {
      futuresTreeRefresh.requestRefresh();
      updateStatusBar();
      const symbols = transitionTargets(opened, closed);
      if (symbols.length > 0) {
        await refreshFutures(true, false, symbols);
      }
    },
    logSessionMonitorError,
  );

  context.subscriptions.push(
    output,
    stockTreeView,
    fundTreeView,
    futuresTreeView,
    statusBar,
    scheduler,
    stockTreeRefresh,
    fundTreeRefresh,
    futuresTreeRefresh,
    sessionMonitors.stock,
    sessionMonitors.fund,
    sessionMonitors.futures,
    commands.registerCommand('fishStock.copyDiagnostics', async () => {
      await env.clipboard.writeText(diagnosticReport());
      window.setStatusBarMessage('FishStock: 已复制脱敏诊断信息', 3_000);
    }),
    commands.registerCommand(SELECT_STATUS_BAR_GROUPS_COMMAND, async () => {
      const groups: StatusBarGroupPick[] = [
        ...stockRepository.getSnapshot().groups.map((group) => ({
          label: group.name,
          description: `Stock · ${group.stocks.length} 个条目`,
          picked: statusBarRotation.isGroupIncluded('stock', group.id),
          viewKind: 'stock' as const,
          groupId: group.id,
        })),
        ...fundRepository.getSnapshot().groups.map((group) => ({
          label: group.name,
          description: `ETF · ${group.stocks.length} 个条目`,
          picked: statusBarRotation.isGroupIncluded('fund', group.id),
          viewKind: 'fund' as const,
          groupId: group.id,
        })),
        ...futuresRepository.getSnapshot().groups.map((group) => ({
          label: group.name,
          description: `Futures · ${group.stocks.length} 个条目`,
          picked: statusBarRotation.isGroupIncluded('futures', group.id),
          viewKind: 'futures' as const,
          groupId: group.id,
        })),
      ];
      const picked = await window.showQuickPick<StatusBarGroupPick>(groups, {
        canPickMany: true,
        title: '选择状态栏轮播分组',
        placeHolder: '勾选参与轮播的分组；全部取消可关闭轮播',
      });
      if (!picked) {
        return;
      }
      const included: Record<StatusBarGroupKind, string[]> = {
        stock: [],
        fund: [],
        futures: [],
      };
      for (const group of picked) {
        included[group.viewKind].push(group.groupId);
      }
      await statusBarRotation.setIncludedGroupIds(statusBarGroupIds(), included);
      updateStatusBar();
      window.setStatusBarMessage(
        picked.length === 0
          ? 'FishStock: 状态栏轮播已关闭'
          : `FishStock: ${picked.length} 个分组参与状态栏轮播`,
        2_500,
      );
    }),
    ...registerWatchlistCommands({
      repository: stockRepository,
      search: (query, signal) => stockProvider.searchStocks(query, signal),
      refresh: async (force, manual) => {
        await refreshStocks(force, manual);
        sessionMonitors.stock?.refresh();
      },
      expandAll: () => expandAllGroups(stockRepository, stockTreeProvider, stockTreeView),
      viewOptions,
      treeProvider: stockTreeProvider,
      set: buildStockCommandSet(),
      registerCommonCommands: true,
    }),
    ...registerWatchlistCommands({
      repository: fundRepository,
      search: (query, signal) => fundProvider.searchFunds(query, signal),
      refresh: async (force, manual) => {
        await refreshFunds(force, manual);
        sessionMonitors.fund?.refresh();
      },
      expandAll: () => expandAllGroups(fundRepository, fundTreeProvider, fundTreeView),
      viewOptions,
      treeProvider: fundTreeProvider,
      set: buildFundCommandSet(),
    }),
    ...registerWatchlistCommands({
      repository: futuresRepository,
      search: (query, signal) => futuresProvider.searchFutures(query, signal),
      refresh: async (force, manual) => {
        await refreshFutures(force, manual);
        sessionMonitors.futures?.refresh();
      },
      expandAll: () => expandAllGroups(
        futuresRepository,
        futuresTreeProvider,
        futuresTreeView,
      ),
      viewOptions,
      treeProvider: futuresTreeProvider,
      set: buildFuturesCommandSet(),
    }),
    stockTreeView.onDidCollapseElement((event) => {
      if (event.element instanceof GroupNode) {
        void stockRepository.setGroupCollapsed(event.element.group.id, true);
      }
    }),
    stockTreeView.onDidExpandElement((event) => {
      if (event.element instanceof GroupNode) {
        void stockRepository.setGroupCollapsed(event.element.group.id, false);
      }
    }),
    fundTreeView.onDidCollapseElement((event) => {
      if (event.element instanceof GroupNode) {
        void fundRepository.setGroupCollapsed(event.element.group.id, true);
      }
    }),
    fundTreeView.onDidExpandElement((event) => {
      if (event.element instanceof GroupNode) {
        void fundRepository.setGroupCollapsed(event.element.group.id, false);
      }
    }),
    futuresTreeView.onDidCollapseElement((event) => {
      if (event.element instanceof GroupNode) {
        void futuresRepository.setGroupCollapsed(event.element.group.id, true);
      }
    }),
    futuresTreeView.onDidExpandElement((event) => {
      if (event.element instanceof GroupNode) {
        void futuresRepository.setGroupCollapsed(event.element.group.id, false);
      }
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('fishStock')) {
        return;
      }
      config = readConfig();
      stockQuotes.setStaleAfterMs(config.staleAfterMs);
      fundQuotes.setStaleAfterMs(config.staleAfterMs);
      futuresQuotes.setStaleAfterMs(config.staleAfterMs);
      stockTreeProvider.setColorConvention(config.colorConvention);
      fundTreeProvider.setColorConvention(config.colorConvention);
      futuresTreeProvider.setColorConvention(config.colorConvention);
      statusBar.configure(config.rotationIntervalMs);
      scheduler.configure(config.refreshIntervalMs);
      stockTreeRefresh.requestRefresh();
      fundTreeRefresh.requestRefresh();
      futuresTreeRefresh.requestRefresh();
      updateStatusBar();
      sessionMonitors.stock?.refresh();
      sessionMonitors.fund?.refresh();
      sessionMonitors.futures?.refresh();
    }),
  );

  output.appendLine('FishStock 已启动；股票和境内 ETF 使用腾讯行情，国内期货使用新浪行情。');
  if (context.extensionMode !== ExtensionMode.Test) {
    scheduler.start();
    sessionMonitors.stock.start();
    sessionMonitors.fund.start();
    sessionMonitors.futures.start();
    startBackgroundRefresh(refreshAll, (error) => {
      output.appendLine(`[${new Date().toISOString()}] 首次行情刷新异常：${compactError(error)}`);
    });
  }
}

export function deactivate(): void {}
