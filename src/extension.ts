import {
  commands,
  env,
  ExtensionMode,
  window,
  workspace,
  version as vscodeVersion,
  type ExtensionContext,
  type Disposable,
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
import type { Market, NormalizedSymbol } from './domain/models';
import { isTradingDay, shouldAutoRefresh } from './domain/tradingCalendar';
import { startBackgroundRefresh } from './services/backgroundRefresh';
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
import { prewarmTreeViews } from './ui/prewarmTreeViews';

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
  );
  const futuresQuotes = new QuoteService(
    futuresProvider,
    MIN_FETCH_INTERVAL_MS,
    config.staleAfterMs,
  );
  const fundQuotes = new QuoteService(
    fundProvider,
    MIN_FETCH_INTERVAL_MS,
    config.staleAfterMs,
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

  const refreshFunds = async (force: boolean, manual: boolean): Promise<void> => {
    if (!manual && !fundProvider.canAutomaticallyRefresh()) {
      return;
    }
    const state = fundRepository.getSnapshot();
    const symbols: NormalizedSymbol[] = state.groups.flatMap((group) =>
      group.stocks.map((fund) => ({ symbol: fund.symbol, market: fund.market })),
    );
    const result = await fundQuotes.refresh(symbols, force);
    fundRefreshState = result.error ? 'error' : 'success';
    fundRefreshAt = new Date().toISOString();
    fundTreeRefresh.requestRefresh();
    updateStatusBar();
    if (result.error) {
      output.appendLine(`[${new Date().toISOString()}] 基金行情刷新失败：${result.error}`);
      if (manual) {
        window.setStatusBarMessage('FishStock: 基金行情刷新失败，正在显示缓存', 4_000);
      }
    } else if (manual) {
      window.setStatusBarMessage('FishStock: 基金行情已刷新', 2_500);
    }
  };
  updateStatusBar();

  const refreshStocks = async (force: boolean, manual: boolean): Promise<void> => {
    if (!manual && !stockProvider.canAutomaticallyRefresh()) {
      return;
    }
    const state = stockRepository.getSnapshot();
    const symbols: NormalizedSymbol[] = state.groups.flatMap((group) =>
      group.stocks.map((stock) => ({ symbol: stock.symbol, market: stock.market })),
    );
    const result = await stockQuotes.refresh(symbols, force);
    stockRefreshState = result.error ? 'error' : 'success';
    stockRefreshAt = new Date().toISOString();
    stockTreeRefresh.requestRefresh();
    updateStatusBar();
    if (result.error) {
      output.appendLine(`[${new Date().toISOString()}] 股票行情刷新失败：${result.error}`);
      if (manual) {
        window.setStatusBarMessage('FishStock: 股票行情刷新失败，正在显示缓存', 4_000);
      }
    } else if (manual) {
      window.setStatusBarMessage('FishStock: 股票行情已刷新', 2_500);
    }
  };

  const refreshFutures = async (force: boolean, manual: boolean): Promise<void> => {
    if (!manual && !futuresProvider.canAutomaticallyRefresh()) {
      return;
    }
    const state = futuresRepository.getSnapshot();
    const symbols: NormalizedSymbol[] = state.groups.flatMap((group) =>
      group.stocks.map((future) => ({ symbol: future.symbol, market: future.market })),
    );
    const result = await futuresQuotes.refresh(symbols, force);
    futuresRefreshState = result.error ? 'error' : 'success';
    futuresRefreshAt = new Date().toISOString();
    futuresTreeRefresh.requestRefresh();
    updateStatusBar();
    if (result.error) {
      output.appendLine(`[${new Date().toISOString()}] 期货行情刷新失败：${result.error}`);
      if (manual) {
        window.setStatusBarMessage('FishStock: 期货行情刷新失败，正在显示缓存', 4_000);
      }
    } else if (manual) {
      window.setStatusBarMessage('FishStock: 期货行情已刷新', 2_500);
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
      stock: summarizeWatchlist(
        stockRepository.getSnapshot(),
        stockProvider.displayName,
        (symbol) => stockQuotes.get(symbol)?.state,
        stockRefreshState,
        stockRefreshAt,
        stockProvider.getNextAutomaticRetryAt()?.toISOString(),
      ),
      fund: summarizeWatchlist(
        fundRepository.getSnapshot(),
        fundProvider.displayName,
        (symbol) => fundQuotes.get(symbol)?.state,
        fundRefreshState,
        fundRefreshAt,
        fundProvider.getNextAutomaticRetryAt()?.toISOString(),
      ),
      futures: summarizeWatchlist(
        futuresRepository.getSnapshot(),
        futuresProvider.displayName,
        (symbol) => futuresQuotes.get(symbol)?.state,
        futuresRefreshState,
        futuresRefreshAt,
        futuresProvider.getNextAutomaticRetryAt()?.toISOString(),
      ),
    });
  };
  const scheduler = new RefreshScheduler(config.refreshIntervalMs, async () => {
    try {
      const now = new Date();
      await Promise.all([
        shouldAutoRefresh(activeStockMarkets(), now)
          ? refreshStocks(false, false)
          : Promise.resolve(),
        shouldAutoRefresh(activeFundMarkets(), now)
          ? refreshFunds(false, false)
          : Promise.resolve(),
        shouldAutoRefresh(activeFuturesMarkets(), now)
          ? refreshFutures(false, false)
          : Promise.resolve(),
      ]);
    } catch (error: unknown) {
      output.appendLine(`[${new Date().toISOString()}] 刷新任务异常：${compactError(error)}`);
    }
  });

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
      refresh: refreshStocks,
      expandAll: () => expandAllGroups(stockRepository, stockTreeProvider, stockTreeView),
      viewOptions,
      treeProvider: stockTreeProvider,
      set: buildStockCommandSet(),
      registerCommonCommands: true,
    }),
    ...registerWatchlistCommands({
      repository: fundRepository,
      search: (query, signal) => fundProvider.searchFunds(query, signal),
      refresh: refreshFunds,
      expandAll: () => expandAllGroups(fundRepository, fundTreeProvider, fundTreeView),
      viewOptions,
      treeProvider: fundTreeProvider,
      set: buildFundCommandSet(),
    }),
    ...registerWatchlistCommands({
      repository: futuresRepository,
      search: (query, signal) => futuresProvider.searchFutures(query, signal),
      refresh: refreshFutures,
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
      void refreshAll();
    }),
  );

  output.appendLine('FishStock 已启动；股票和境内 ETF 使用腾讯行情，国内期货使用新浪行情。');
  if (context.extensionMode !== ExtensionMode.Test) {
    let prewarmRegistration: Disposable | undefined;
    const prewarmTimer = setTimeout(() => {
      prewarmRegistration = prewarmTreeViews(
        [
          {
            label: 'Stock',
            treeView: stockTreeView,
            element: stockTreeProvider.getGroupNodes()[0],
          },
          {
            label: 'Fund',
            treeView: fundTreeView,
            element: fundTreeProvider.getGroupNodes()[0],
          },
          {
            label: 'Futures',
            treeView: futuresTreeView,
            element: futuresTreeProvider.getGroupNodes()[0],
          },
        ],
        {
          restorePreviousSidebar: () =>
            commands.executeCommand('workbench.action.previousSideBarView'),
          onError: (label, error) => {
            output.appendLine(
              `[${new Date().toISOString()}] ${label} 预初始化失败：${compactError(error)}`,
            );
          },
        },
      );
    }, 0);
    context.subscriptions.push({
      dispose: () => {
        clearTimeout(prewarmTimer);
        prewarmRegistration?.dispose();
      },
    });
    scheduler.start();
    startBackgroundRefresh(refreshAll, (error) => {
      output.appendLine(`[${new Date().toISOString()}] 首次行情刷新异常：${compactError(error)}`);
    });
  }
}

export function deactivate(): void {}
